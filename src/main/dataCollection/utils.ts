// Fisher-Yates shuffle. Pure: returns a new array, leaves input intact.
export function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    // Indexed assignment via a temp — destructuring swap trips
    // noUncheckedIndexedAccess (T | undefined on the RHS).
    const tmp = a[i] as T;
    a[i] = a[j] as T;
    a[j] = tmp;
  }
  return a;
}
