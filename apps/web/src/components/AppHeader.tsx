import { Radio } from 'lucide-react';
import { Link } from 'react-router';
import { SettingsButtonGroup } from '../settings/SettingsDialog';

export interface AppHeaderProps {
  darkMode: boolean;
  onToggleDarkMode: () => void;
  onOpenSettings: () => void;
}

export function AppHeader({ darkMode, onToggleDarkMode, onOpenSettings }: AppHeaderProps) {
  return <header className="sticky top-0 z-10 bg-background py-3" data-slot="app-header">
    <div className="mx-auto flex min-h-12 w-[min(56rem,calc(100%_-_2rem))] items-center justify-between gap-2 rounded-full border border-primary/20 bg-primary-foreground px-2 py-1.5 shadow-sm">
      <Link
        to="/"
        aria-label="Podcaster home"
        className="inline-flex items-center gap-2 rounded-md text-primary outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <Radio className="size-5 shrink-0" aria-hidden="true" />
        <span className="font-semibold tracking-tight">Podcaster</span>
      </Link>
      <SettingsButtonGroup
        darkMode={darkMode}
        onToggleDarkMode={onToggleDarkMode}
        onOpenSettings={onOpenSettings}
        buttonClassName="border-primary/20 bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary"
      />
    </div>
  </header>;
}
