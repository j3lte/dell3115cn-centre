import { BottomNav } from "./components/layout/BottomNav";
import { Sidebar } from "./components/layout/Sidebar";
import { ConnectionBar } from "./components/status/ConnectionBar";
import { NoticeBar } from "./components/status/NoticeBar";
import { PrinterAlert } from "./components/status/PrinterAlert";
import { cx } from "./helpers/format";
import { visibleRoutes } from "./helpers/routes";
import { headerAlert, navDot } from "./helpers/printer";
import { useLive } from "./hooks/useLive";
import { usePrinter } from "./hooks/usePrinter";
import { useFeatures } from "./hooks/useFeatures";
import { useProfiles } from "./hooks/useProfiles";
import { useRoute } from "./hooks/useRoute";
import { AnalysePage } from "./pages/AnalysePage";
import { HistoryPage } from "./pages/HistoryPage";
import { ProfilesPage } from "./pages/ProfilesPage";
import { ScanPage } from "./pages/ScanPage";
import { PrinterPage } from "./pages/PrinterPage";
import { SettingsPage } from "./pages/SettingsPage";

/**
 * Shell. Phone (< 768 px): top connection bar + bottom tab bar. Tablet (768–1023 px): icon rail on the left + top
 * connection bar. Desktop (≥ 1024 px): sidebar with the connection status at its top.
 */
export function App() {
  const live = useLive();
  const features = useFeatures();
  const routes = visibleRoutes(features);
  const route = useRoute(routes);
  const profiles = useProfiles();
  const printer = usePrinter();
  const printerError = headerAlert(printer.view);
  const dot = navDot(printer.view);

  return (
    <div className="min-h-dvh pb-[calc(64px+env(safe-area-inset-bottom))] md:pb-0 md:pl-22 lg:pl-64">
      <Sidebar state={live.state} onConnect={live.reconnect} route={route} routes={routes} dot={dot} printerError={printerError} />

      <div className="lg:hidden">
        <ConnectionBar state={live.state} onConnect={live.reconnect} />
        {printerError && <PrinterAlert text={printerError} variant="bar" />}
      </div>

      {live.state.notice && <NoticeBar message={live.state.notice.message} onDismiss={() => live.dispatch({ type: "dismissNotice" })} />}

      <main className={cx("mx-auto px-4 pt-3 pb-6 md:px-6 lg:px-8 lg:pt-6", route === "scan" || route === "history" || route === "profiles" ? "max-w-[1400px]" : "max-w-3xl")}>
        {profiles.error && <p className="msg msg-error mb-3">{profiles.error}</p>}
        {route === "scan" && <ScanPage live={live} profiles={profiles} />}
        {route === "history" && <HistoryPage live={live} profiles={profiles} />}
        {route === "analyse" && <AnalysePage />}
        {route === "printer" && <PrinterPage printer={printer} />}
        {route === "profiles" && <ProfilesPage profiles={profiles} />}
        {route === "settings" && <SettingsPage profiles={profiles} />}
      </main>

      <BottomNav route={route} routes={routes} dot={dot} />
    </div>
  );
}
