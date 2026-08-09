# Page snapshot

```yaml
- main [ref=e3]:
  - paragraph [ref=e4]: Local readiness
  - heading "Set up your thinking companion" [level=1] [ref=e5]
  - region "Before you continue" [ref=e6]:
    - heading "Before you continue" [level=2] [ref=e7]
    - paragraph [ref=e8]:
      - strong [ref=e9]: Speech recognition and voice playback run locally.
      - text: For a response, the current transcript, bounded recent conversation context, your validated persona interpretation, and the selected response posture are sent through Pi/Codex to its configured cloud model provider. Raw audio and your full local history are not sent.
    - paragraph [ref=e10]: This app does not request an ordinary API key and has no silent metered-provider fallback. The configured provider—not this app—controls its handling, retention, and model-improvement use under your account and settings.
    - paragraph [ref=e11]:
      - link "Codex data handling" [ref=e12] [cursor=pointer]:
        - /url: https://help.openai.com/en/articles/11369540-codex-in-chatgpt-faq
      - text: ·
      - link "OpenAI data controls" [ref=e13] [cursor=pointer]:
        - /url: https://help.openai.com/en/articles/5722486/data-controls-faq
      - text: ·
      - link "OpenAI privacy policy" [ref=e14] [cursor=pointer]:
        - /url: https://openai.com/policies/privacy-policy/
    - button "Checking…" [disabled] [ref=e15]
```