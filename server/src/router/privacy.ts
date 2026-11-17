export interface PrivacyInput { private?: boolean; hasAttachments?: boolean; allowCloud?: boolean }
/**
 * Privacy rule: private Gems, private Notebooks and attachments go local-only (Ollama) unless the user
 * overrides for that single message (allowCloud). Enforced when building the candidate list.
 */
export function isLocalOnly(p: PrivacyInput): boolean {
  if (p.allowCloud) return false;
  return !!p.private || !!p.hasAttachments;
}
export function privacyReason(p: PrivacyInput): string | undefined {
  if (p.allowCloud) return undefined;
  if (p.private) return "private content stays on this machine";
  if (p.hasAttachments) return "attachments stay on this machine (override per message to use cloud)";
  return undefined;
}
