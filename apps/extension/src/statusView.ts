import type { ServiceStatus } from "./status";

export function renderStatus(target: HTMLElement, status: ServiceStatus): void {
  target.replaceChildren();
  const row = document.createElement("div");
  row.className = "row";
  const dot = document.createElement("span");
  dot.className = status.state === "online" ? "dot" : "dot off";
  const text = document.createElement("span");
  text.textContent = status.state === "online" ? `Online · ${status.ms} ms` : `Offline · ${status.reason}`;
  row.append(dot, text);
  target.append(row);
  if (status.state === "offline") {
    const hint = document.createElement("p");
    hint.className = "help";
    hint.textContent = "Your files are not affected. Try again in a moment.";
    target.append(hint);
  }
}

export function renderChecking(target: HTMLElement): void {
  target.replaceChildren();
  const group = document.createElement("div");
  group.className = "skeleton-group";
  group.setAttribute("aria-hidden", "true");
  for (const width of ["100%", "60%"]) {
    const bar = document.createElement("div");
    bar.className = "skeleton";
    bar.style.height = "14px";
    bar.style.width = width;
    group.append(bar);
  }
  target.append(group);
  target.setAttribute("aria-busy", "true");
}
