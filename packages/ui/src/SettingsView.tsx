import type { Settings, SortCategory } from "@gendragoon/core";
import { SORT_CATEGORIES } from "@gendragoon/core";

export function SettingsView(props: {
  settings: Settings;
  rows: { extension: string; category: SortCategory; source: "default" | "override" }[];
  onChange: (extension: string, category: SortCategory) => void;
}) {
  return (
    <section data-testid="settings-view">
      <header className="topbar">
        <div>
          <div className="kicker"><span className="dot" /> SETTINGS</div>
          <h2>Type sorting</h2>
          <p className="sub">Pictures, Videos, Audio, Documents, Archives, Apps, and Other. Overrides are saved in Settings. Every client starts from the same sort-map.json.</p>
        </div>
      </header>
      <div className="panel">
        {props.rows.map((row) => (
          <div className="map-row" key={row.extension}>
            <code>{row.extension}</code>
            <span className="kind">{row.source === "override" ? "Saved override" : "Canonical map"}</span>
            <select
              aria-label={`Category for ${row.extension}`}
              data-testid={`sort-${row.extension}`}
              value={row.category}
              onChange={(event) => props.onChange(row.extension, event.target.value as SortCategory)}
            >
              {SORT_CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}
            </select>
          </div>
        ))}
      </div>
      <p className="footer-note">{Object.keys(props.settings.sortOverrides.extensions).length} extension override(s) stored on this device.</p>
    </section>
  );
}
