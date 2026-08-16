import { Moon, Settings, Sun } from 'lucide-react';
import { Button } from '../components/ui/button';
import { ButtonGroup } from '../components/ui/button-group';

export function ThemeToggle({ darkMode, onToggle, className }: { darkMode: boolean; onToggle: () => void; className?: string }) {
  const label = darkMode ? 'Dark mode on. Switch to light mode' : 'Dark mode off. Switch to dark mode';
  return <Button
    variant="outline"
    size="icon"
    title={label}
    aria-label={label}
    aria-pressed={darkMode}
    onClick={onToggle}
    className={className}
  >
    {darkMode ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
  </Button>;
}

export function SettingsButton({ onClick, title = 'Open settings', className }: { onClick: () => void; title?: string; className?: string }) {
  return <Button variant="outline" size="icon" title={title} aria-label={title} onClick={onClick} className={className}><Settings aria-hidden="true" /></Button>;
}

export function SettingsButtonGroup({ darkMode, onToggleDarkMode, onOpenSettings, settingsTitle = 'Open settings', buttonClassName }: {
  darkMode: boolean;
  onToggleDarkMode: () => void;
  onOpenSettings: () => void;
  settingsTitle?: string;
  buttonClassName?: string;
}) {
  return <ButtonGroup aria-label="Appearance and settings controls">
    <ThemeToggle darkMode={darkMode} onToggle={onToggleDarkMode} {...(buttonClassName ? { className: buttonClassName } : {})} />
    <SettingsButton onClick={onOpenSettings} title={settingsTitle} {...(buttonClassName ? { className: buttonClassName } : {})} />
  </ButtonGroup>;
}
