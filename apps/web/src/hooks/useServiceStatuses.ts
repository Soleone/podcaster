import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { SettingsModel } from '../settings/settings-model';
import { bootstrapCapability } from '../sessions/session-archive';
import { DISCLOSURE_KEY, DISCLOSURE_VERSION } from '../components/PrivacyDialog';
import { fakeServiceStatuses, initialServiceStatuses, serviceStatusFromAudioEngine, serviceStatusesFromSnapshot, type ReadinessSnapshot, type ServiceStatuses } from '../services/service-status';

const fakeServices = import.meta.env.MODE === 'fake-services';

function disclosureWasAcknowledged(): boolean {
  if (fakeServices) return true;
  try { return localStorage.getItem(DISCLOSURE_KEY) === DISCLOSURE_VERSION; }
  catch { return false; }
}

export interface UseServiceStatusesOptions {
  /** Shared handle owned by App; the settings hook mirrors its model into it. */
  settingsModelRef: RefObject<SettingsModel>;
}

export interface UseServiceStatusesResult {
  capability: string | undefined;
  setCapability: (capability: string | undefined) => void;
  capabilityRef: RefObject<string | undefined>;
  serviceStatuses: ServiceStatuses;
  /** Projects live session audio-engine state into the header status. */
  applyAudioEngine: (engine: Parameters<typeof serviceStatusFromAudioEngine>[0]) => void;
  latestReadinessSnapshot: ReadinessSnapshot | undefined;
  refreshServiceStatus: (requestedCapability?: string, microphoneOverride?: boolean) => Promise<void>;
  refreshingServiceStatus: boolean;
  servicesConnecting: boolean;
  connectServices: () => Promise<void>;
  privacyAcknowledged: boolean;
  privacyDialogOpen: boolean;
  setPrivacyDialogOpen: (open: boolean) => void;
  openServicesConnection: () => void;
  microphoneGranted: boolean;
  enableMicrophone: () => Promise<void>;
}

/**
 * Owns the host connection lifecycle: capability bootstrap, the readiness
 * poll, microphone permission, privacy acknowledgment, and the derived
 * per-service statuses shown in the header.
 */
export function useServiceStatuses({ settingsModelRef }: UseServiceStatusesOptions): UseServiceStatusesResult {
  const [capability, setCapability] = useState<string | undefined>(() => fakeServices ? 'fake' : undefined);
  const capabilityRef = useRef<string | undefined>(capability);
  capabilityRef.current = capability;
  const [privacyAcknowledged, setPrivacyAcknowledged] = useState(disclosureWasAcknowledged);
  const [privacyDialogOpen, setPrivacyDialogOpen] = useState(false);
  const [microphoneGranted, setMicrophoneGranted] = useState(false);
  const [servicesConnecting, setServicesConnecting] = useState(false);
  const [serviceStatuses, setServiceStatuses] = useState<ServiceStatuses>(() => fakeServices ? fakeServiceStatuses : initialServiceStatuses);
  const [latestReadinessSnapshot, setLatestReadinessSnapshot] = useState<ReadinessSnapshot>();
  const [refreshingServiceStatus, setRefreshingServiceStatus] = useState(false);

  const applyReadinessSnapshot = useCallback((snapshot: ReadinessSnapshot) => {
    setServiceStatuses(serviceStatusesFromSnapshot(snapshot));
    setLatestReadinessSnapshot(snapshot);
  }, []);

  const applyAudioEngine = useCallback((engine: Parameters<typeof serviceStatusFromAudioEngine>[0]) => {
    setServiceStatuses(previous => ({ ...previous, audio: serviceStatusFromAudioEngine(engine) }));
  }, []);

  const refreshServiceStatus = useCallback(async (requestedCapability?: string, microphoneOverride?: boolean) => {
    const activeCapability = requestedCapability ?? capabilityRef.current;
    if (!activeCapability) return;
    setRefreshingServiceStatus(true);
    try {
      const granted = microphoneOverride ?? await navigator.permissions?.query({ name: 'microphone' as PermissionName }).then(permission => permission.state === 'granted').catch(() => false) ?? false;
      setMicrophoneGranted(granted);
      const response = await fetch('/api/readiness', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-podcaster-capability': activeCapability },
        body: JSON.stringify({ microphoneGranted: granted, ttsModel: settingsModelRef.current.selectedModel, pi: settingsModelRef.current.pi }),
      });
      if (!response.ok) throw new Error('service status request failed');
      applyReadinessSnapshot(await response.json() as ReadinessSnapshot);
    } catch {
      // Keep the last known state visible. A single dropped poll should not
      // make healthy services flash unavailable.
    } finally {
      setRefreshingServiceStatus(false);
    }
  }, [applyReadinessSnapshot, settingsModelRef]);

  const serviceConnectionRef = useRef<Promise<void> | undefined>(undefined);
  const connectServices = useCallback(async () => {
    if (fakeServices) return;
    if (serviceConnectionRef.current) return serviceConnectionRef.current;
    let work!: Promise<void>;
    work = (async () => {
      setServicesConnecting(true);
      try {
        const nextCapability = await bootstrapCapability();
        capabilityRef.current = nextCapability;
        setCapability(nextCapability);
        setPrivacyAcknowledged(true);
        try { localStorage.setItem(DISCLOSURE_KEY, DISCLOSURE_VERSION); } catch { /* service connection still works for this session */ }
        await refreshServiceStatus(nextCapability);
      } catch (cause) {
        capabilityRef.current = undefined;
        setCapability(undefined);
        throw cause instanceof Error ? cause : new Error('Services could not be connected.');
      } finally {
        setServicesConnecting(false);
        if (serviceConnectionRef.current === work) serviceConnectionRef.current = undefined;
      }
    })();
    serviceConnectionRef.current = work;
    return work;
  }, [refreshServiceStatus]);

  const enableMicrophone = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot request microphone access.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
    for (const track of stream.getTracks()) track.stop();
    setMicrophoneGranted(true);
    await refreshServiceStatus(undefined, true);
  }, [refreshServiceStatus]);

  useEffect(() => {
    if (fakeServices || !privacyAcknowledged || capability) return;
    void connectServices().catch(() => undefined);
  }, [capability, connectServices, privacyAcknowledged]);

  useEffect(() => {
    if (!capability) return;
    let cancelled = false;
    void refreshServiceStatus();
    const timer = setInterval(() => { if (!cancelled) void refreshServiceStatus(); }, 4_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [capability, refreshServiceStatus]);

  const openServicesConnection = useCallback(() => {
    if (privacyAcknowledged) { void connectServices().catch(() => undefined); return; }
    setPrivacyDialogOpen(true);
  }, [connectServices, privacyAcknowledged]);

  return {
    capability,
    setCapability,
    capabilityRef,
    serviceStatuses,
    applyAudioEngine,
    latestReadinessSnapshot,
    refreshServiceStatus,
    refreshingServiceStatus,
    servicesConnecting,
    connectServices,
    privacyAcknowledged,
    privacyDialogOpen,
    setPrivacyDialogOpen,
    openServicesConnection,
    microphoneGranted,
    enableMicrophone,
  };
}
