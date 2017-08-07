import {
  compileToIR,
  CompilationContext as NewCompilationContext,
  SelectionSet,
  Field as NewField,
  TypeCondition,
  FragmentSpread
} from './';
import { GraphQLSchema, GraphQLType, GraphQLObjectType, GraphQLCompositeType, DocumentNode } from 'graphql';
import { mergeInFragmentSpreads, collectFragmentsReferenced } from './mergeInFragmentSpreads';
import { TypeCase } from './flattenIR';

import { inspect } from 'util';

export interface CompilerOptions {
  addTypename?: boolean;
  mergeInFieldsFromFragmentSpreads?: boolean;
  passthroughCustomScalars?: boolean;
  customScalarsPrefix?: string;
  namespace?: string;
  generateOperationIds?: boolean;
}

export interface CompilationContext {
  schema: GraphQLSchema;
  operations: { [operationName: string]: CompiledOperation };
  fragments: { [fragmentName: string]: CompiledFragment };
  typesUsed: GraphQLType[];
  options: CompilerOptions;
}

export interface CompiledOperation {
  filePath?: string;
  operationName: string;
  operationId?: string;
  operationType: string;
  rootType: GraphQLObjectType;
  variables: {
    name: string;
    type: GraphQLType;
  }[];
  source: string;
  sourceWithFragments?: string;
  fields: Field[];
  fragmentSpreads?: string[];
  inlineFragments?: CompiledInlineFragment[];
  fragmentsReferenced: string[];
}

export interface CompiledFragment {
  filePath?: string;
  fragmentName: string;
  source: string;
  typeCondition: GraphQLCompositeType;
  possibleTypes: GraphQLObjectType[];
  fields: Field[];
  fragmentSpreads: string[];
  inlineFragments: any[];
}

export interface CompiledInlineFragment {
  typeCondition: GraphQLObjectType;
  possibleTypes: GraphQLObjectType[];
  fields: Field[];
  fragmentSpreads: string[];
}

export interface Field {
  responseName: string;
  fieldName: string;
  args?: Argument[];
  type: GraphQLType;
  description?: string;
  isConditional?: boolean;
  isDeprecated?: boolean;
  deprecationReason?: string;
  fields?: Field[];
  fragmentSpreads?: string[];
  inlineFragments?: CompiledInlineFragment[];
}

export interface Argument {
  name: string;
  value: any;
}

export function compileToLegacyIR(
  schema: GraphQLSchema,
  document: DocumentNode,
  options: CompilerOptions = { mergeInFieldsFromFragmentSpreads: true }
): CompilationContext {
  const context = compileToIR(schema, document, options);

  const operations: { [operationName: string]: CompiledOperation } = Object.create({});

  for (const [operationName, operation] of Object.entries(context.operations)) {
    const { selectionSet, ...operationWithoutSelectionSet } = operation;
    operations[operationName] = {
      ...operationWithoutSelectionSet,
      fragmentsReferenced: Array.from(collectFragmentsReferenced(context, selectionSet)),
      ...transformSelectionSetToLegacyIR(context, selectionSet)
    };
  }

  const fragments: { [fragmentName: string]: CompiledFragment } = Object.create({});

  for (const [fragmentName, fragment] of Object.entries(context.fragments)) {
    const { selectionSet, type, ...fragmentWithoutSelectionSet } = fragment;
    fragments[fragmentName] = {
      typeCondition: type,
      possibleTypes: selectionSet.possibleTypes,
      ...fragmentWithoutSelectionSet,
      ...transformSelectionSetToLegacyIR(context, selectionSet)
    };
  }

  const legacyContext: CompilationContext = {
    schema: context.schema,
    operations,
    fragments,
    typesUsed: context.typesUsed,
    options
  };

  return legacyContext;
}

function transformSelectionSetToLegacyIR(context: NewCompilationContext, selectionSet: SelectionSet) {
  const typeCase = new TypeCase(
    context.options.mergeInFieldsFromFragmentSpreads
      ? mergeInFragmentSpreads(context, selectionSet)
      : selectionSet
  );

  const fields: Field[] = transformFieldsToLegacyIR(context, typeCase.default.fields);

  const inlineFragments: CompiledInlineFragment[] = typeCase.records
    .filter(
      record =>
        // Filter out records that represent the same possible types as the default record.
        !selectionSet.possibleTypes.every(type => record.possibleTypes.includes(type)) &&
        // Filter out empty records for consistency with legacy compiler.
        record.fieldMap.size > 0
    )
    .flatMap(record => {
      const fields = transformFieldsToLegacyIR(context, record.fields);
      return record.possibleTypes.map(possibleType => {
        return {
          typeCondition: possibleType,
          possibleTypes: [possibleType],
          fields
        } as CompiledInlineFragment;
      });
    });

  for (const inlineFragment of inlineFragments) {
    inlineFragments[inlineFragment.typeCondition.name as any] = inlineFragment;
  }

  const fragmentSpreads: string[] = selectionSet.selections
    .filter((selection): selection is FragmentSpread => selection.kind === 'FragmentSpread')
    .map((fragmentSpread: FragmentSpread) => fragmentSpread.fragmentName);

  return { fields, inlineFragments, fragmentSpreads };
}

function transformFieldsToLegacyIR(context: NewCompilationContext, fields: NewField[]) {
  return fields.map(field => {
    const { args, type, description, isDeprecated, deprecationReason, selectionSet } = field;
    return {
      responseName: field.alias || field.name,
      fieldName: field.name,
      args,
      type,
      description,
      isDeprecated,
      deprecationReason,
      ...selectionSet ? transformSelectionSetToLegacyIR(context, selectionSet) : {}
    } as Field;
  });
}

declare global {
  interface Array<T> {
    flatMap<E>(callback: (t: T) => Array<E>): Array<E>;
  }
}

Object.defineProperty(Array.prototype, 'flatMap', {
  value: function(f: Function) {
    return this.reduce((ys: any, x: any) => {
      return ys.concat(f.call(this, x));
    }, []);
  },
  enumerable: false
});
