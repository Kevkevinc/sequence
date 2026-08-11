'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Asks to send "your videos are ready", and registers the phone if allowed.
 *
 * Deliberately not asked on first load. A permission prompt fired at somebody
 * who has not yet seen what the product does is the fastest way to a permanent
 * "no" — and once denied, the browser will not ask again, so the channel is
 * gone for good on that device. This renders where the creator has just started
 * a render and has an obvious reason to want to be told when it finishes.
 */

/**
 * The push service needs the key as bytes, not the base64url string we ship.
 *
 * Built on an explicit `ArrayBuffer` rather than `Uint8Array.from`, because the
 * subscription API wants a view backed by a real ArrayBuffer and the generic
 * form is not guaranteed to be one.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

type State = 'unsupported' | 'not-installed' | 'idle' | 'asking' | 'on' | 'blocked';

export function NotifyWhenReady() {
  const [state, setState] = useState<State>('idle');

  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      setState('unsupported');
      return;
    }

    /*
     * iPhone only allows notifications for a site added to the home screen.
     * Asking before that produces an error rather than a prompt, so the creator
     * is told what to do instead — this is the one step of installing a web app
     * that a phone will not do on its own.
     */
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const installed =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    if (isIos && !installed) {
      setState('not-installed');
      return;
    }

    if (Notification.permission === 'denied') {
      setState('blocked');
      return;
    }
    if (Notification.permission === 'granted') {
      setState('on');
      // Re-register silently: browsers rotate these, and the server upserts on
      // the endpoint, so this cannot pile up duplicates.
      void register();
      return;
    }
    setState('idle');
    // `register` is stable and intentionally excluded; including it would
    // re-run this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const register = useCallback(async () => {
    const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!key) return false;

    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;

      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          // Required: a push that cannot be shown to the user is not allowed.
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key),
        }));

      const response = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      });
      return response.ok;
    } catch (error) {
      console.warn('Could not register for notifications', error);
      return false;
    }
  }, []);

  async function turnOn() {
    setState('asking');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      setState(permission === 'denied' ? 'blocked' : 'idle');
      return;
    }
    setState((await register()) ? 'on' : 'idle');
  }

  if (state === 'unsupported' || state === 'on') return null;

  if (state === 'not-installed') {
    return (
      <p className="helper" style={{ marginTop: 10 }}>
        Want to be told when your videos are ready? Tap Share, then <b>Add to Home Screen</b>, and
        open Sequence from your home screen.
      </p>
    );
  }

  if (state === 'blocked') {
    return (
      <p className="helper" style={{ marginTop: 10 }}>
        Notifications are turned off for Sequence in your phone&rsquo;s settings.
      </p>
    );
  }

  return (
    <button
      type="button"
      className="btn"
      onClick={turnOn}
      disabled={state === 'asking'}
      style={{ marginTop: 12 }}
    >
      {state === 'asking' ? 'Just a sec…' : 'Notify me when this is ready'}
    </button>
  );
}
