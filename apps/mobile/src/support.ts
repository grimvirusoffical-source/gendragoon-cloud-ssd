/** TODO: delete this shim on rebase onto PR #1 and import { SUPPORT_CONTACT } from "@gendragoon/core". */
export const SUPPORT_CONTACT: { value: string; isPlaceholder: boolean } = { value: "SUPPORT_CONTACT_PLACEHOLDER@invalid", isPlaceholder: true };

/** An address with @ and no scheme is mailed. Anything else is opened as a URL. */
export function supportContactTarget(value: string, jobId: string): string {
  if (/^[^\s@]+@[^\s@]+$/.test(value)) {
    const subject = encodeURIComponent(`Account deletion ${jobId}`);
    return `mailto:${value}?subject=${subject}`;
  }
  return value;
}
