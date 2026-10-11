/** 启动前拒绝会被运行时转换、或改变显式恢复语义的参数；错误不回显原值。 */
export function task_timeout_error(timeout_ms: unknown): string | null {
  return typeof timeout_ms === "number" && Number.isInteger(timeout_ms) && timeout_ms > 0 && timeout_ms <= 2_147_483_647
    ? null : "timeout_ms 必须是1到2147483647的整数";
}

export function resume_session_error(session_id: unknown, cli: boolean): string | null {
  return typeof session_id === "string" && session_id.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(session_id) && (!cli || !session_id.startsWith("-"))
    ? null : "原生resume session ID无效";
}
