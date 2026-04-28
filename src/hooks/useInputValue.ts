// Subscribe a React component to a named channel on the InputBus.
// Re-renders the component on every published change.
//
// Use sparingly — for high-rate channels (60Hz mic samples) this triggers a
// React render every frame. Acceptable for small leaf components like the
// status bar; not appropriate for heavy panels. Heavy consumers (PixiJS
// render loop, bindings) should use `inputBus.get(name)` directly.

import { useEffect, useState } from "react";
import { inputBus } from "../inputs/InputBus";

export function useInputValue<T>(name: string): T | undefined {
  const [value, setValue] = useState<T | undefined>(() =>
    inputBus.get<T>(name),
  );

  useEffect(() => {
    setValue(inputBus.get<T>(name));
    return inputBus.subscribe<T>(name, setValue);
  }, [name]);

  return value;
}
