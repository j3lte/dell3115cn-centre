import { useThemeChoice } from "../../hooks/useThemeChoice";
import { CardTitle } from "../ui/CardTitle";
import { Segmented } from "../ui/Segmented";

/** Settings card: light/dark/system theme, kept on this device. */
export function ThemeSetting() {
  const [theme, setTheme] = useThemeChoice();
  return (
    <section className="card">
      <CardTitle>Appearance</CardTitle>
      <Segmented
        label="Theme"
        value={theme}
        options={[
          ["system", "System"],
          ["light", "Light"],
          ["dark", "Dark"],
        ]}
        onChange={setTheme}
      />
      <p className="hint m-0">Saved on this device only. System follows the device's light or dark setting.</p>
    </section>
  );
}
