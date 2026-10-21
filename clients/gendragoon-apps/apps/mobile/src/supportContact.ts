/** An address with @ and no scheme is mailed. Anything else is opened as a URL. */
export function supportContactTarget(value: string, jobId: string): string {
  if (/^[^\s@]+@[^\s@]+$/.test(value)) {
    const subject = encodeURIComponent(`Account deletion ${jobId}`);
    return `mailto:${value}?subject=${subject}`;
  }
  return value;
}
