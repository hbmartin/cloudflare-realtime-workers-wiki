export function LoadingSplash() {
  return (
    <main className="startup-splash">
      <div className="brand-mark" aria-hidden="true">
        N
      </div>
      <p aria-live="polite" aria-atomic="true">
        Opening Notes…
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
