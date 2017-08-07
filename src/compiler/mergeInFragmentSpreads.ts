import { CompilationContext, SelectionSet, Selection } from './';

export function mergeInFragmentSpreads(
  context: CompilationContext,
  selectionSet: SelectionSet
): SelectionSet {
  const selections: Selection[] = [];

  for (const selection of selectionSet.selections) {
    switch (selection.kind) {
      case 'FragmentSpread':
        const fragment = context.fragments[selection.fragmentName];
        if (!fragment) {
          throw new Error(`Cannot find fragment "${selection.fragmentName}"`);
        }

        // Compute the intersection.
        const possibleTypes = fragment.selectionSet.possibleTypes.filter(type =>
          selectionSet.possibleTypes.includes(type)
        );

        selections.push({
          kind: 'TypeCondition',
          type: fragment.type,
          selectionSet: mergeInFragmentSpreads(context, {
            possibleTypes,
            selections: fragment.selectionSet.selections
          })
        });
        break;
      case 'TypeCondition':
      case 'BooleanCondition':
        selections.push({
          ...selection,
          selectionSet: mergeInFragmentSpreads(context, selection.selectionSet)
        });
        break;
      default:
        selections.push(selection);
        break;
    }
  }

  return {
    possibleTypes: selectionSet.possibleTypes,
    selections
  };
}

export function collectFragmentsReferenced(
  context: CompilationContext,
  selectionSet: SelectionSet,
  fragmentsReferenced: Set<string> = new Set()
): Set<string> {
  for (const selection of selectionSet.selections) {
    switch (selection.kind) {
      case 'FragmentSpread':
        fragmentsReferenced.add(selection.fragmentName);

        const fragment = context.fragments[selection.fragmentName];
        if (!fragment) {
          throw new Error(`Cannot find fragment "${selection.fragmentName}"`);
        }

        collectFragmentsReferenced(context, fragment.selectionSet, fragmentsReferenced);
        break;
      case 'Field':
      case 'TypeCondition':
      case 'BooleanCondition':
        if (selection.selectionSet) {
          collectFragmentsReferenced(context, selection.selectionSet, fragmentsReferenced);
        }
        break;
    }
  }

  return fragmentsReferenced;
}
