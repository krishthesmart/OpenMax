export interface McpStatus { name: string; url: string; connected: boolean; tools: string[]; error?: string }
const state = new Map<string, McpStatus>();
export const setMcpStatus = (s: McpStatus) => state.set(s.name, s);
export const getMcpStatuses = () => [...state.values()];
