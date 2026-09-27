// Increment only for a wire-format break, not for ordinary product releases.
export const apiProtocol = 1;
export const runtimeProtocol = 1;
export const compatibility = { api_protocol: apiProtocol, runtime_protocol: runtimeProtocol };
// Clients and golden images predating negotiation speak the original v1 protocol.
export function reportedProtocol(value: string | string[] | undefined): number {
  return value === undefined ? 1 : typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : 0;
}
