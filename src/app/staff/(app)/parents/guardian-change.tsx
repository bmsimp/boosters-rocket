import { NoteAction, OneButton } from "./forms";
import { reinstateGuardianAction, removeGuardianAction } from "./actions";

/**
 * Beside one guardian row, for staff with `Parents.ReadWrite` (src/lib/parents/guardians.ts): remove an open row, with
 * a note only staff see, or reinstate a closed one. A row a change of company closed is offered nothing. Used on a
 * family's roster page and a person's page. `name` names the row for a screen reader, since every row has the same
 * words.
 */
export function GuardianChange({ name, guardianId, open, reinstatable }: { name: string; guardianId: string; open: boolean; reinstatable: boolean }) {
  if (open) {
    return (
      <details className="more"><summary>Remove<span className="visually-hidden"> {name}</span></summary>
        <p>They can&apos;t sign in to this family any more, and are signed out of it at once, whatever the family owes. Forms still waiting for their signature start again.</p>
        <NoteAction label="Remove" field="Why? (staff only)" pendingLabel="Removing…" act={removeGuardianAction.bind(null, guardianId)} />
      </details>
    );
  }
  if (reinstatable) return <OneButton label={`Reinstate ${name}`} pendingLabel="Reinstating…" act={reinstateGuardianAction.bind(null, guardianId)} />;
  return null;
}
