import { Radio } from 'lucide-react';
import { Link } from 'react-router';
import { SettingsButtonGroup } from '../settings/SettingsDialog';

export interface AppHeaderProps {
  darkMode: boolean;
  onToggleDarkMode: () => void;
  onOpenSettings: () => void;
}

export function AppHeader({ darkMode, onToggleDarkMode, onOpenSettings }: AppHeaderProps) {
  return <header className="sticky top-0 z-10 border-b bg-background" data-slot="app-header">
    <div className="mx-auto flex h-16 w-[min(56rem,calc(100%_-_2rem))] items-center justify-between gap-4">
      <Link
        to="/"
        aria-label="Podcaster home"
        className="inline-flex items-center gap-2 rounded-md text-primary outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <Radio className="size-5 shrink-0" aria-hidden="true" />
        <span className="font-semibold tracking-tight">Podcaster</span>
      </Link>
      <SettingsButtonGroup darkMode={darkMode} onToggleDarkMode={onToggleDarkMode} onOpenSettings={onOpenSettings} />
    </div>
  </header>;
}
