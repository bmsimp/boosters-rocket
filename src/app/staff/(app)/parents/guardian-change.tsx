import { GuardianChangeControls } from "./forms";
import { reinstateGuardianAction, removeGuardianAction } from "./actions";

/**
 * Beside one guardian row, for staff with `Roster.Family.ReadWrite` (src/lib/parents/guardians.ts): remove an open row, with
 * a note only staff see, or reinstate a closed one. A row a change of company closed is offered nothing. Used on a
 * family's roster page and a person's page. `name` names the row in Reinstate, and `removeLabel` says whom Remove
 * takes out of which family. The controls are one client component whatever the row's state, so its answer outlives the swap.
 */
export function GuardianChange({ name, removeLabel, guardianId, open, reinstatable }: { name: string; removeLabel: string; guardianId: string; open: boolean; reinstatable: boolean }) {
  return <GuardianChangeControls name={name} removeLabel={removeLabel} open={open} reinstatable={reinstatable}
    remove={removeGuardianAction.bind(null, guardianId)} reinstate={reinstateGuardianAction.bind(null, guardianId)} />;
}
