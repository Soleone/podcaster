import { describe, expect, it } from 'vitest';
import { CLASSIFIER_SYSTEM_PROMPT, fallbackInterruptionDecision, hasCorrectionIntent, hasLexicalContent, isBareRedirection, parseInterruptionDecision, PiInterruptionIntentClassifier } from '../../src/session/InterruptionIntentClassifier.js';
import type { PiClient, PiEvent, PiRequestInput } from '../../src/pi/PiClient.js';

class FakeClassifierPi implements PiClient {
  readonly inputs: PiRequestInput[] = [];
  async probe() { return { status: 'ready' as const, detail: '', correctiveAction: 'None.' }; }
  async *request(input: PiRequestInput): AsyncIterable<PiEvent> {
    this.inputs.push(input);
    yield { type: 'final', text: JSON.stringify({ action: 'resume', intent: 'non_substantive', confidence: 'high', reason: 'No lexical content.' }) };
  }
  async shutdown() {}
}

describe('interruption intent contract', () => {
  it.each([
    ['{"action":"resume","intent":"continue_previous","confidence":"high","reason":"Asked to carry on."}', 'resume'],
    ['{"action":"accept","intent":"correction","confidence":"medium","reason":"Corrects the premise."}', 'accept'],
  ])('accepts a strict bounded decision', (json, action) => expect(parseInterruptionDecision(json)?.action).toBe(action));

  it.each([
    '{"action":"accept","intent":"new_request","confidence":"low","reason":"Ambiguous.","extra":true}',
    '{"action":"accept","intent":"continue_previous","confidence":"high","reason":"Contradiction."}',
    'not json',
  ])('rejects invalid classifier output %s', json => expect(parseInterruptionDecision(json)).toBeUndefined());

  it.each([['', false], ['…', false], ['uh', true], ['¿podrías seguir?', true]])('uses only lexical preflight for %j', (text, expected) => expect(hasLexicalContent(text)).toBe(expected));

  it.each([
    ['', 'resume'],
    ['um', 'resume'],
    ['okay continue', 'resume'],
    ["that's really interesting", 'resume'],
    ['No wait', 'accept'],
    ['Hold off for a second', 'accept'],
    ['Can we discuss another system?', 'accept'],
    // Representative corrections from the reported interruption bug: these must
    // take over the paused answer, never resume it as control-only speech.
    ["No I no I don't mean that it's a more recent one", 'accept'],
    ['No no no not those try to think of something else', 'accept'],
    ['Not that one, the newer one', 'accept'],
    ["That's wrong", 'accept'],
    ['Something else entirely', 'accept'],
    // Bare content-bearing redirections (the reported "Fantasy setting" case)
    // must take over deterministically, while fillers, acknowledgements, noise,
    // and explicit continue requests keep resuming.
    ['Fantasy setting', 'accept'],
    ['The third chapter', 'accept'],
    ['The other one', 'accept'],
    ['Cats', 'accept'],
    ['Second option', 'accept'],
    ['Yes', 'resume'],
    ['Right', 'resume'],
    ['Sure', 'resume'],
    ['Thanks', 'resume'],
    ['Thank you', 'resume'],
    ['No problem', 'resume'],
    ['Please', 'resume'],
    ['More', 'resume'],
    ['Oh', 'resume'],
    ['Umm hmm', 'resume'],
    ['Sounds good', 'resume'],
    ['And then', 'resume'],
    ['So the thing is', 'resume'],
    ['Very cool', 'resume'],
    ['You know', 'resume'],
  ])('falls back safely for %j when model classification is unavailable', (text, action) => {
    expect(fallbackInterruptionDecision(text).action).toBe(action);
  });

  it.each([
    ["No I no I don't mean that it's a more recent one", true],
    ['No no no not those try to think of something else', true],
    ['Not that one', true],
    ["That's wrong", true],
    ['Different idea', true],
    ['Something else', true],
    ['Never mind', true],
    ['No wait', true],
    ['No problem', false],
    ['No worries', false],
    ["Don't worry about it", false],
    ['No no, go on', false],
    ['Okay continue', false],
    ["Don't continue with that", true],
    ['Never go on about it', true],
    ['Fantasy setting', false],
    ["That's really interesting", false],
    ['um', false],
  ])('detects correction intent for %j', (text, expected) => {
    expect(hasCorrectionIntent(text)).toBe(expected);
  });

  it.each([
    ['The third chapter', true],
    ['The other one', true],
    ['Cats', true],
    ['Second option', true],
    ['Yes', false],
    ['Right', false],
    ['No problem', false],
    ['Thank you', false],
    ['Oh the fantasy setting', false],
    ['Umm hmm', false],
    ['Sounds good', false],
    ['Looks like the old one', false],
    ['And then', false],
    ["That's really interesting", false],
    ['Very cool', false],
    ['You know', false],
    ['Go on', false],
    ['Okay continue', false],
    ['Um', false],
    ['', false],
  ])('detects a bare content-bearing redirection for %j', (text, expected) => {
    expect(isBareRedirection(text)).toBe(expected);
  });

  it('keeps interruption classification persona-neutral with a fixed system prompt', async () => {
    const pi = new FakeClassifierPi();
    const classifier = new PiInterruptionIntentClassifier(pi);
    const decision = await classifier.decide(
      { interruptedResponseText: 'Some paused answer', deliveredSampleOffset: 10, generatedSamples: 100, transcript: 'uh', boundedContext: '' },
      new AbortController().signal,
    );
    const input = pi.inputs[0]!;
    expect(Object.keys(input).sort()).toEqual(['boundedContext', 'maxWords', 'posture', 'transcript']);
    expect(JSON.stringify(input)).not.toContain('persona');
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('Return ONLY compact JSON');
    expect(CLASSIFIER_SYSTEM_PROMPT.toLowerCase()).not.toContain('persona');
    expect(decision.action).toBe('resume');
  });
});
