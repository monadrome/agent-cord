/** 保留旧内部导入路径；共享文件边界由 core 维护（ADR-0036）。 */
export {
  readSessionDocument, statSessionDocument, writeSessionDocument,
  resolveSessionFile, resolveSafeSessionFile, SessionFileError, SessionFileConflictError,
} from "../core/session-files.js";
