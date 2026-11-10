// Transient execution data only. Never attach this to Job or ExecutionResult.
export interface ExecutionDiagnostics {
  stage: 'preparing'|'request'|'response_body'|'response_parse'|'response_validation'|'image_decode';
  reason?: 'timeout'|'cancelled'|'network_error'|'http_error'|'empty_response'|'response_too_large'|'invalid_json'|'response_read_error'|'validation_error'|'image_decode_error'|'execution_error';
  timeout_ms?: number;
  http_status?: number;
  received_bytes?: number;
  upstream_request_id?: string;
  error_name?: string;
  error_code?: string;
}
