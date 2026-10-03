use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::{
    documents::{self, DirectoryEntryKind},
    error::{AppError, AppResult, CommandResult},
    project_settings::{self, ProjectSettings},
    workspace_session::{self, WorkspaceSession},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFolder {
    path: String,
    name: String,
    available: bool,
    workspace_file: Option<String>,
    settings: ProjectSettings,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIssue {
    path: String,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    folders: Vec<WorkspaceFolder>,
    issues: Vec<WorkspaceIssue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializedWorkspace {
    snapshot: WorkspaceSnapshot,
    settings_path: String,
}

#[derive(Default)]
struct WorkspaceMembership {
    loaded: bool,
    roots: Vec<PathBuf>,
}

#[derive(Clone)]
pub struct WorkspaceState {
    session_path: PathBuf,
    membership: Arc<Mutex<WorkspaceMembership>>,
}

impl WorkspaceState {
    pub fn new(config_directory: &Path) -> Self {
        Self {
            session_path: workspace_session::file_path(config_directory),
            membership: Arc::new(Mutex::new(WorkspaceMembership::default())),
        }
    }

    fn membership(&self) -> AppResult<MutexGuard<'_, WorkspaceMembership>> {
        self.membership
            .lock()
            .map_err(|_| AppError::Runtime("workspace membership lock is poisoned".to_owned()))
    }

    fn ensure_loaded(&self, state: &mut WorkspaceMembership) -> AppResult<()> {
        if !state.loaded {
            // A failed restoration remains observable; a subsequent explicit open can replace it.
            state.loaded = true;
            if let Some(session) = workspace_session::read(&self.session_path)? {
                state.roots = session
                    .into_roots()
                    .into_iter()
                    .map(PathBuf::from)
                    .collect();
            }
        }
        Ok(())
    }

    pub fn restore(&self) -> AppResult<Option<WorkspaceSnapshot>> {
        let mut state = self.membership()?;
        self.ensure_loaded(&mut state)?;
        Ok((!state.roots.is_empty()).then(|| snapshot(&state.roots)))
    }

    pub fn add(&self, paths: Vec<String>) -> AppResult<WorkspaceSnapshot> {
        if paths.is_empty() || paths.len() > workspace_session::MAX_WORKSPACE_ROOTS {
            return Err(AppError::InvalidPath(
                "select a bounded, nonempty collection of workspace folders".to_owned(),
            ));
        }
        let mut state = self.membership()?;
        self.ensure_loaded(&mut state)?;
        let mut next = state.roots.clone();
        let mut seen: HashSet<String> = next
            .iter()
            .map(|path| workspace_session::path_key(path))
            .collect();
        for path in paths {
            for root in discover_folders(Path::new(&path))? {
                if seen.insert(workspace_session::path_key(&root)) {
                    if next.len() == workspace_session::MAX_WORKSPACE_ROOTS {
                        return Err(AppError::InvalidSettings(format!(
                            "a workspace session supports at most {} roots",
                            workspace_session::MAX_WORKSPACE_ROOTS
                        )));
                    }
                    next.push(root);
                }
            }
        }
        self.persist(&next)?;
        state.roots = next;
        Ok(snapshot(&state.roots))
    }

    pub fn remove(&self, path: String) -> AppResult<WorkspaceSnapshot> {
        let mut state = self.membership()?;
        self.ensure_loaded(&mut state)?;
        let key = workspace_session::path_key(Path::new(&path));
        let next: Vec<PathBuf> = state
            .roots
            .iter()
            .filter(|root| workspace_session::path_key(root) != key)
            .cloned()
            .collect();
        if next.len() == state.roots.len() {
            return Err(AppError::InvalidPath(
                "the folder is not part of this workspace session".to_owned(),
            ));
        }
        self.persist(&next)?;
        state.roots = next;
        Ok(snapshot(&state.roots))
    }

    pub fn refresh(&self) -> AppResult<WorkspaceSnapshot> {
        let mut state = self.membership()?;
        self.ensure_loaded(&mut state)?;
        Ok(snapshot(&state.roots))
    }

    pub fn initialize(&self, path: String) -> AppResult<InitializedWorkspace> {
        let mut state = self.membership()?;
        self.ensure_loaded(&mut state)?;
        let key = workspace_session::path_key(Path::new(&path));
        let root = state
            .roots
            .iter()
            .find(|root| workspace_session::path_key(root) == key)
            .ok_or_else(|| {
                AppError::InvalidPath("configuration requires an open workspace folder".to_owned())
            })?;
        let canonical = canonical_directory(root)?;
        let settings_path = project_settings::initialize(&canonical, folder_name(&canonical))?;
        Ok(InitializedWorkspace {
            snapshot: snapshot(&state.roots),
            settings_path: project_settings::display_path(&settings_path),
        })
    }

    fn persist(&self, roots: &[PathBuf]) -> AppResult<()> {
        let session = WorkspaceSession::from_roots(
            roots
                .iter()
                .map(|root| project_settings::display_path(root))
                .collect(),
        )?;
        workspace_session::write(&self.session_path, &session)
    }
}

fn discover_folders(path: &Path) -> AppResult<Vec<PathBuf>> {
    let canonical = canonical_directory(path)?;
    if marker_exists(&canonical)? {
        return Ok(vec![canonical]);
    }
    let mut identified = Vec::new();
    for entry in documents::list_directory(canonical.clone())? {
        if matches!(entry.kind, DirectoryEntryKind::Directory) {
            let child = PathBuf::from(entry.path);
            if marker_exists(&child)? {
                identified.push(canonical_directory(&child)?);
            }
        }
    }
    if identified.is_empty() {
        Ok(vec![canonical])
    } else {
        Ok(identified)
    }
}

fn marker_exists(root: &Path) -> AppResult<bool> {
    let path = root
        .join(project_settings::CONFIG_DIRECTORY_NAME)
        .join(project_settings::WORKSPACE_FILE_NAME);
    path.try_exists()
        .map_err(|error| AppError::io(format!("could not inspect {}", path.display()), error))
}

fn canonical_directory(path: &Path) -> AppResult<PathBuf> {
    if !path.is_absolute() {
        return Err(AppError::InvalidPath(
            "workspace paths must be absolute".to_owned(),
        ));
    }
    let canonical = fs::canonicalize(path).map_err(|error| {
        AppError::io(
            format!("could not resolve workspace {}", path.display()),
            error,
        )
    })?;
    if !canonical.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "{} is not a directory",
            path.display()
        )));
    }
    Ok(canonical)
}

fn snapshot(roots: &[PathBuf]) -> WorkspaceSnapshot {
    let mut issues = Vec::new();
    let folders = roots
        .iter()
        .map(|root| {
            let path = project_settings::display_path(root);
            let mut folder = WorkspaceFolder {
                path: path.clone(),
                name: folder_name(root),
                available: false,
                workspace_file: None,
                settings: ProjectSettings::default(),
            };
            let canonical = match canonical_directory(root) {
                Ok(path) => path,
                Err(error) => {
                    issues.push(WorkspaceIssue {
                        path,
                        message: error.to_string(),
                    });
                    return folder;
                }
            };
            folder.available = true;
            match project_settings::read_descriptor(&canonical) {
                Ok(Some(descriptor)) => {
                    folder.name = descriptor.name;
                    folder.workspace_file = Some(project_settings::display_path(
                        &canonical
                            .join(project_settings::CONFIG_DIRECTORY_NAME)
                            .join(project_settings::WORKSPACE_FILE_NAME),
                    ));
                }
                Ok(None) => {}
                Err(error) => issues.push(WorkspaceIssue {
                    path: project_settings::display_path(
                        &canonical
                            .join(project_settings::CONFIG_DIRECTORY_NAME)
                            .join(project_settings::WORKSPACE_FILE_NAME),
                    ),
                    message: error.to_string(),
                }),
            }
            match project_settings::read_settings(&canonical) {
                Ok(settings) => folder.settings = settings,
                Err(error) => issues.push(WorkspaceIssue {
                    path: project_settings::display_path(
                        &canonical
                            .join(project_settings::CONFIG_DIRECTORY_NAME)
                            .join(project_settings::SETTINGS_FILE_NAME),
                    ),
                    message: error.to_string(),
                }),
            }
            folder
        })
        .collect();
    WorkspaceSnapshot { folders, issues }
}

fn folder_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
        .unwrap_or_else(|| project_settings::display_path(path))
}

pub fn state_for_app(app: &AppHandle) -> AppResult<WorkspaceState> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| AppError::InvalidPath(error.to_string()))?;
    Ok(WorkspaceState::new(&directory))
}

#[tauri::command]
pub async fn restore_workspace(
    state: State<'_, WorkspaceState>,
) -> CommandResult<Option<WorkspaceSnapshot>> {
    let state = state.inner().clone();
    crate::run_blocking(move || state.restore()).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn add_workspace_folders(
    state: State<'_, WorkspaceState>,
    paths: Vec<String>,
) -> CommandResult<WorkspaceSnapshot> {
    let state = state.inner().clone();
    crate::run_blocking(move || state.add(paths)).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn remove_workspace_folder(
    state: State<'_, WorkspaceState>,
    path: String,
) -> CommandResult<WorkspaceSnapshot> {
    let state = state.inner().clone();
    crate::run_blocking(move || state.remove(path)).await
}

#[tauri::command]
pub async fn refresh_workspace(
    state: State<'_, WorkspaceState>,
) -> CommandResult<WorkspaceSnapshot> {
    let state = state.inner().clone();
    crate::run_blocking(move || state.refresh()).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn initialize_workspace_folder(
    state: State<'_, WorkspaceState>,
    path: String,
) -> CommandResult<InitializedWorkspace> {
    let state = state.inner().clone();
    crate::run_blocking(move || state.initialize(path)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    type TestResult = Result<(), Box<dyn std::error::Error>>;

    fn folder(parent: &Path, name: &str, identified: bool) -> AppResult<PathBuf> {
        let path = parent.join(name);
        fs::create_dir(&path)
            .map_err(|error| AppError::io("could not create test folder", error))?;
        if identified {
            project_settings::initialize(&path, name.to_owned())?;
        }
        Ok(path)
    }

    #[test]
    fn discovers_only_identified_direct_children_and_keeps_their_settings_independent() -> TestResult
    {
        let parent = tempdir()?;
        let api = folder(parent.path(), "api", true)?;
        let web = folder(parent.path(), "web", true)?;
        let ordinary = folder(parent.path(), "ordinary", false)?;
        folder(&ordinary, "deep", true)?;
        fs::write(
            api.join(".sideral/settings.json"),
            r#"{"schemaVersion":1,"editor":{"tabSize":2}}"#,
        )?;
        fs::write(
            web.join(".sideral/settings.json"),
            r#"{"schemaVersion":1,"editor":{"tabSize":8}}"#,
        )?;
        let profile = tempdir()?;
        let snapshot = WorkspaceState::new(profile.path())
            .add(vec![project_settings::display_path(parent.path())])?;
        assert_eq!(
            snapshot
                .folders
                .iter()
                .map(|folder| folder.name.as_str())
                .collect::<Vec<_>>(),
            vec!["api", "web"]
        );
        assert_eq!(
            snapshot.folders[0]
                .settings
                .editor
                .as_ref()
                .and_then(|editor| editor.tab_size),
            Some(2)
        );
        assert_eq!(
            snapshot.folders[1]
                .settings
                .editor
                .as_ref()
                .and_then(|editor| editor.tab_size),
            Some(8)
        );
        assert!(snapshot.issues.is_empty());
        assert!(!parent.path().join(".sideral").exists());
        Ok(())
    }

    #[test]
    fn a_marked_parent_is_a_single_workspace_with_multiple_projects_inside() -> TestResult {
        let parent = tempdir()?;
        folder(parent.path(), "api", true)?;
        folder(parent.path(), "web", true)?;
        project_settings::initialize(parent.path(), "Platform".to_owned())?;
        let profile = tempdir()?;
        let snapshot = WorkspaceState::new(profile.path())
            .add(vec![project_settings::display_path(parent.path())])?;
        assert_eq!(snapshot.folders.len(), 1);
        assert_eq!(snapshot.folders[0].name, "Platform");
        Ok(())
    }

    #[test]
    fn adds_without_duplicates_and_removes_membership_without_deleting_project_files() -> TestResult
    {
        let parent = tempdir()?;
        let api = folder(parent.path(), "api", false)?;
        let web = folder(parent.path(), "web", false)?;
        let profile = tempdir()?;
        let state = WorkspaceState::new(profile.path());
        state.add(vec![project_settings::display_path(&api)])?;
        let snapshot = state.add(vec![
            project_settings::display_path(&web),
            project_settings::display_path(&api.join(".")),
        ])?;
        assert_eq!(snapshot.folders.len(), 2);
        assert_eq!(snapshot.folders[0].name, "api");
        state.initialize(snapshot.folders[1].path.clone())?;
        let removed = state.remove(snapshot.folders[0].path.clone())?;
        assert_eq!(removed.folders.len(), 1);
        assert!(api.exists());
        assert!(web.join(".sideral/workspace.json").exists());
        let restored = WorkspaceState::new(profile.path())
            .restore()?
            .ok_or("missing session")?;
        assert_eq!(restored.folders[0].path, removed.folders[0].path);
        state.remove(removed.folders[0].path.clone())?;
        assert!(WorkspaceState::new(profile.path()).restore()?.is_none());
        Ok(())
    }

    #[test]
    fn reports_missing_roots_and_invalid_configuration_without_discarding_other_projects()
    -> TestResult {
        let parent = tempdir()?;
        let api = folder(parent.path(), "api", true)?;
        let web = folder(parent.path(), "web", true)?;
        let profile = tempdir()?;
        let state = WorkspaceState::new(profile.path());
        state.add(vec![
            project_settings::display_path(&api),
            project_settings::display_path(&web),
        ])?;
        fs::write(api.join(".sideral/settings.json"), "broken JSON")?;
        let invalid = state.refresh()?;
        assert_eq!(invalid.folders.len(), 2);
        assert_eq!(invalid.issues.len(), 1);
        assert!(invalid.issues[0].path.ends_with("settings.json"));
        fs::rename(&api, parent.path().join("moved-api"))?;
        let restored = WorkspaceState::new(profile.path())
            .restore()?
            .ok_or("missing session")?;
        assert!(!restored.folders[0].available);
        assert!(restored.folders[1].available);
        assert_eq!(restored.issues.len(), 1);
        Ok(())
    }

    #[test]
    fn a_failed_persist_never_publishes_partial_membership() -> TestResult {
        let parent = tempdir()?;
        let api = folder(parent.path(), "api", false)?;
        let web = folder(parent.path(), "web", false)?;
        let profile = tempdir()?;
        let state = WorkspaceState::new(profile.path());
        state.add(vec![project_settings::display_path(&api)])?;
        let session = workspace_session::file_path(profile.path());
        fs::remove_file(&session)?;
        fs::create_dir(&session)?;
        assert!(
            state
                .add(vec![project_settings::display_path(&web)])
                .is_err()
        );
        assert_eq!(state.refresh()?.folders.len(), 1);
        assert_eq!(state.refresh()?.folders[0].name, "api");
        Ok(())
    }
}
