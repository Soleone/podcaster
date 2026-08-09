# Page snapshot

```yaml
- main [ref=e3]:
  - paragraph [ref=e4]: Local readiness
  - heading "Set up your thinking companion" [level=1] [ref=e5]
  - region "Readiness" [ref=e6]:
    - heading "Readiness" [level=2] [ref=e7]
    - status [ref=e8]: Secure local connection established. Audio capture has not started.
    - list [ref=e9]:
      - listitem [ref=e10]:
        - generic [ref=e11]:
          - strong [ref=e12]: Voice input
          - generic [ref=e13]: Ready
        - paragraph [ref=e14]: Microphone permission is ready.
        - paragraph [ref=e15]:
          - strong [ref=e16]: "Next:"
          - text: No action needed.
      - listitem [ref=e17]:
        - generic [ref=e18]:
          - strong [ref=e19]: Voice output
          - generic [ref=e20]: Unavailable
        - paragraph [ref=e21]: Selected local audio runtime is not ready.
        - paragraph [ref=e22]:
          - strong [ref=e23]: "Next:"
          - text: Wait for selected model startup or restart the host.
      - listitem [ref=e24]:
        - generic [ref=e25]:
          - strong [ref=e26]: Cloud reasoning
          - generic [ref=e27]: Ready
        - paragraph [ref=e28]: Pi is ready.
        - paragraph [ref=e29]:
          - strong [ref=e30]: "Next:"
          - text: None.
    - status [ref=e31]: Microphone permission is ready. Capture is stopped until the session starts.
    - button "Start session" [disabled] [ref=e32]
    - paragraph [ref=e33]: Active conversation is unavailable until the host audio-model integration is ready.
    - group [ref=e34]
```