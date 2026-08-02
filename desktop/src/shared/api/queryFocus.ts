import { focusManager } from "@tanstack/react-query";

/**
 * Teach React Query what "focused" means in a desktop window.
 *
 * v5's default focus manager listens to `visibilitychange` and nothing else.
 * That is the right signal for a browser tab, where switching tabs hides the
 * document — but a Tauri window stays visible when you switch to another
 * application, so the event never fires and `refetchOnWindowFocus: true` is
 * silently inert. Every query in the app that opted into it (project sync
 * status, local checkouts, workflows) was therefore refetching only on mount.
 *
 * Window `focus`/`blur` are the events that actually track the OS window, and
 * they fire in the webview when the window gains or loses focus. Registering
 * them here replaces the default listener rather than adding to it, which is
 * what `setEventListener` is for.
 *
 * Returns a cleanup function that detaches the listeners by installing an inert
 * one — `setEventListener` runs the previous cleanup before subscribing again,
 * and there is no public way to restore the library default. That is fine for
 * the one caller: it installs at app start and detaches only at teardown.
 *
 * Safe to call in a non-browser environment, where it registers nothing and
 * returns a no-op.
 */
export function installWindowFocusManager(): () => void {
  if (typeof window === "undefined") return () => {};

  focusManager.setEventListener((handleFocus) => {
    const onFocus = () => handleFocus(true);
    const onBlur = () => handleFocus(false);
    // Kept alongside the window events rather than dropped: a minimised or
    // fully occluded window can still report a visibility change, and honouring
    // it avoids refetching for a window nobody is looking at.
    const onVisibilityChange = () =>
      handleFocus(document.visibilityState === "visible");

    window.addEventListener("focus", onFocus, false);
    window.addEventListener("blur", onBlur, false);
    document.addEventListener("visibilitychange", onVisibilityChange, false);

    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  });

  return () => focusManager.setEventListener(() => () => {});
}
