import { useState } from 'react';
import { Button } from '../components/ui/button';
import { playSampleExchange } from './sample-exchange';

// Demo build only (see App.tsx): plays one canned exchange, because nothing the visitor says is heard.
export function SampleExchangeButton() {
  const [playing, setPlaying] = useState(false);
  return (
    <div className="mx-auto mt-5 flex w-[min(56rem,calc(100%_-_2rem))] flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
      <span>Demo build: replies are canned and nothing you say is transcribed.</span>
      <Button
        variant="outline"
        size="sm"
        disabled={playing}
        onClick={async () => {
          const api = window.__podcasterTest;
          if (!api) return;
          setPlaying(true);
          try {
            await playSampleExchange(api);
          } finally {
            setPlaying(false);
          }
        }}
      >
        Play sample exchange
      </Button>
    </div>
  );
}
