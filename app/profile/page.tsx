'use client';

import { useEffect, useState } from 'react';

export default function ProfilePage() {
  const [height, setHeight] = useState('');
  const [weight, setWeight] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch('/api/profile')
      .then((res) => res.json())
      .then((data) => {
        setHeight(data?.height ?? '');
        setWeight(data?.weight ?? '');
      });
  }, []);

  async function handleSave() {
    setSaved(false);
    await fetch('/api/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ height, weight }),
    });
    setSaved(true);
  }

  return (
    <main>
      <h1>Your Profile</h1>
      <label>
        Height
        <input value={height} onChange={(e) => setHeight(e.target.value)} placeholder={'e.g. 5\'6"'} />
      </label>
      <label>
        Weight
        <input value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="e.g. 135 lbs" />
      </label>
      <button onClick={handleSave}>Save</button>
      {saved && <p>Saved.</p>}
    </main>
  );
}
