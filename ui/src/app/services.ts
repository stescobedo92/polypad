/** Everything the window is made of once it has started. */
import { createActions, type Actions } from "./actions";
import { startSession, type AppSession, type SessionDeps } from "./session";
import { createUi, type Ui } from "./ui";

export interface AppServices {
  readonly session: AppSession;
  readonly ui: Ui;
  readonly actions: Actions;
}

/**
 * Starts the session and what the UI drives it with. Called once per window, outside React, so
 * that a development double render cannot start two sessions that journal over each other.
 */
export async function startApp(deps: SessionDeps): Promise<AppServices> {
  const session = await startSession(deps);
  const ui = createUi();
  const { skipped } = session.notices;
  if (skipped.length > 0) {
    ui.setState({ notice: { key: "notices.skipped", values: { names: skipped.join(", ") } } });
  }
  return { session, ui, actions: createActions(session, ui) };
}
