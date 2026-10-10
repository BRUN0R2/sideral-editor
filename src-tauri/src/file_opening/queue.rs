use std::collections::VecDeque;

use serde::Serialize;

use crate::error::{AppError, AppResult};

use super::launch::LaunchFiles;

const MAX_PENDING_REQUESTS: usize = 64;
const MAX_PENDING_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOpenRequest {
    pub id: u32,
    pub files: LaunchFiles,
}

#[derive(Default)]
pub struct FileOpenQueue {
    pub requests: VecDeque<FileOpenRequest>,
    last_id: u32,
    pending_bytes: usize,
}

impl FileOpenQueue {
    pub fn enqueue(&mut self, files: LaunchFiles) -> AppResult<Option<FileOpenRequest>> {
        if files.is_empty() {
            return Ok(None);
        }
        let bytes = files.byte_size();
        if self.requests.len() >= MAX_PENDING_REQUESTS
            || bytes > MAX_PENDING_BYTES.saturating_sub(self.pending_bytes)
        {
            return Err(AppError::Runtime(
                "the file-opening queue is full; wait for the editor and open the files again"
                    .to_owned(),
            ));
        }
        let id = self.last_id.checked_add(1).ok_or_else(|| {
            AppError::Runtime("file-opening request identifiers are exhausted".to_owned())
        })?;
        let request = FileOpenRequest { id, files };
        self.requests.push_back(request.clone());
        self.last_id = id;
        self.pending_bytes += bytes;
        Ok(Some(request))
    }

    pub fn acknowledge(&mut self, id: u32) -> AppResult<()> {
        let Some(request) = self.requests.front() else {
            return Err(AppError::Runtime(
                "no file-opening request is pending".to_owned(),
            ));
        };
        if request.id != id {
            return Err(AppError::Runtime(
                "file-opening requests must be acknowledged in order".to_owned(),
            ));
        }
        self.pending_bytes -= request.files.byte_size();
        self.requests.pop_front();
        Ok(())
    }
}
