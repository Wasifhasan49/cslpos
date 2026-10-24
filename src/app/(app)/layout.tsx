import { AppShell } from "@/components/app-shell";
import { StaffProvider } from "@/components/staff-provider";

/**
 * Every signed-in screen sits under here, so the staff lookup happens once and the
 * menu and branch switcher are the same everywhere. /login and /pin stay outside: one
 * has no staff yet, the other is a single focused task.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <StaffProvider>
      <AppShell>{children}</AppShell>
    </StaffProvider>
  );
}
