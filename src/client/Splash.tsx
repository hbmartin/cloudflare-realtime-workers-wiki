export function LoadingSplash() {
  return (
    <main className="startup-splash">
      <img className="brand-mark" src="/apple-touch-icon.png" alt="" aria-hidden="true" />
      <p aria-live="polite" aria-atomic="true">
        Opening NoteFlare…
      </p>
    </main>
  );
}

export function AlertSplash({ title, message }: { title: string; message: string }) {
  return (
    <main className="startup-splash">
      <div role="alert">
        <h1>{title}</h1>
        <p>{message}</p>
      </div>
    </main>
  );
}
