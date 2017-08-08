import {
  print,
  typeFromAST,
  getNamedType,
  isAbstractType,
  Kind,
  isCompositeType,
  GraphQLOutputType,
  GraphQLScalarType,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLObjectType,
  GraphQLError,
  GraphQLSchema,
  GraphQLType,
  GraphQLCompositeType,
  DocumentNode,
  OperationDefinitionNode,
  FragmentDefinitionNode,
  SelectionSetNode,
  SelectionNode,
  ArgumentNode
} from 'graphql';

import {
  getOperationRootType,
  getFieldDef,
  valueFromValueNode,
  filePathForNode,
  withTypenameFieldAddedWhereNeeded,
  isBuiltInScalarType,
  isMetaFieldName
} from '../utilities/graphql';

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
  operations: { [operationName: string]: Operation };
  fragments: { [fragmentName: string]: Fragment };
  typesUsed: GraphQLType[];
  options: CompilerOptions;
}

function argumentsFromAST(args: ArgumentNode[]): Argument[] {
  return (
    args &&
    args.map(arg => {
      return { name: arg.name.value, value: valueFromValueNode(arg.value) };
    })
  );
}

export interface Operation {
  operationName: string;
  operationType: string;
  operationId?: string;
  variables: {
    name: string;
    type: GraphQLType;
  }[];
  filePath?: string;
  source: string;
  fragmentsReferenced: string[];
  rootType: GraphQLObjectType;
  selectionSet: SelectionSet;
}

export interface Fragment {
  filePath?: string;
  fragmentName: string;
  source: string;
  type: GraphQLCompositeType;
  selectionSet: SelectionSet;
}

export interface SelectionSet {
  possibleTypes: GraphQLObjectType[];
  selections: Selection[];
}

export interface Argument {
  name: string;
  value: any;
}

export type Selection = Field | TypeCondition | BooleanCondition | FragmentSpread;

export interface Field {
  kind: 'Field';
  name: string;
  alias?: string;
  args?: Argument[];
  type: GraphQLOutputType;
  description?: string;
  isDeprecated?: boolean;
  deprecationReason?: string;
  isConditional?: boolean;
  selectionSet?: SelectionSet;
}

export interface TypeCondition {
  kind: 'TypeCondition';
  type: GraphQLCompositeType;
  selectionSet: SelectionSet;
}

export interface BooleanCondition {
  kind: 'BooleanCondition';
  variableName: string;
  inverted: boolean;
  selectionSet: SelectionSet;
}

export interface FragmentSpread {
  kind: 'FragmentSpread';
  fragmentName: string;
}

export function compileToIR(
  schema: GraphQLSchema,
  document: DocumentNode,
  options: CompilerOptions = {}
): CompilationContext {
  if (options.addTypename) {
    document = withTypenameFieldAddedWhereNeeded(schema, document);
  }

  const compiler = new Compiler(schema, options);

  const operations: { [operationName: string]: Operation } = Object.create(null);
  const fragments: { [fragmentName: string]: Fragment } = Object.create(null);

  for (const definition of document.definitions) {
    switch (definition.kind) {
      case Kind.OPERATION_DEFINITION:
        const operation = compiler.compileOperation(definition);
        operations[operation.operationName] = operation;
        break;
      case Kind.FRAGMENT_DEFINITION:
        const fragment = compiler.compileFragment(definition);
        fragments[fragment.fragmentName] = fragment;
        break;
    }
  }

  const typesUsed = compiler.typesUsed;

  return { schema, operations, fragments, typesUsed, options };
}

class Compiler {
  options: CompilerOptions;
  schema: GraphQLSchema;
  typesUsedSet: Set<GraphQLType>;

  constructor(schema: GraphQLSchema, options: CompilerOptions) {
    this.schema = schema;
    this.options = options;

    this.typesUsedSet = new Set();
  }

  addTypeUsed(type: GraphQLType) {
    if (this.typesUsedSet.has(type)) return;

    if (
      type instanceof GraphQLEnumType ||
      type instanceof GraphQLInputObjectType ||
      (type instanceof GraphQLScalarType && !isBuiltInScalarType(type))
    ) {
      this.typesUsedSet.add(type);
    }
    if (type instanceof GraphQLInputObjectType) {
      for (const field of Object.values(type.getFields())) {
        this.addTypeUsed(getNamedType(field.type));
      }
    }
  }

  get typesUsed(): GraphQLType[] {
    return Array.from(this.typesUsedSet);
  }

  compileOperation(operationDefinition: OperationDefinitionNode): Operation {
    if (!operationDefinition.name) {
      throw new Error('Operations should be named');
    }

    const filePath = filePathForNode(operationDefinition);
    const operationName = operationDefinition.name.value;
    const operationType = operationDefinition.operation;

    const variables = (operationDefinition.variableDefinitions || []).map(node => {
      const name = node.variable.name.value;
      const type = typeFromAST(this.schema, node.type);
      this.addTypeUsed(getNamedType(type));
      return { name, type };
    });

    const source = print(operationDefinition);
    const rootType = getOperationRootType(this.schema, operationDefinition);

    return {
      filePath,
      operationName,
      operationType,
      variables,
      source,
      rootType,
      selectionSet: this.compileSelectionSet(operationDefinition.selectionSet, rootType)
    };
  }

  compileFragment(fragmentDefinition: FragmentDefinitionNode): Fragment {
    const fragmentName = fragmentDefinition.name.value;

    const filePath = filePathForNode(fragmentDefinition);
    const source = print(fragmentDefinition);

    const type = typeFromAST(this.schema, fragmentDefinition.typeCondition) as GraphQLCompositeType;

    return {
      fragmentName,
      filePath,
      source,
      type,
      selectionSet: this.compileSelectionSet(fragmentDefinition.selectionSet, type)
    };
  }

  compileSelectionSet(
    selectionSetNode: SelectionSetNode,
    parentType: GraphQLCompositeType,
    possibleTypes: GraphQLObjectType[] = this.possibleTypesForType(parentType)
  ): SelectionSet {
    return {
      possibleTypes,
      selections: selectionSetNode.selections.map(selectionNode =>
        this.compileSelection(selectionNode, parentType, possibleTypes)
      )
    };
  }

  compileSelection(
    selectionNode: SelectionNode,
    parentType: GraphQLCompositeType,
    possibleTypes: GraphQLObjectType[]
  ): Selection {
    switch (selectionNode.kind) {
      case Kind.FIELD: {
        const name = selectionNode.name.value;
        const alias = selectionNode.alias ? selectionNode.alias.value : undefined;

        const args =
          selectionNode.arguments && selectionNode.arguments.length > 0
            ? argumentsFromAST(selectionNode.arguments)
            : undefined;

        const fieldDefinition = getFieldDef(this.schema, parentType, selectionNode);
        if (!fieldDefinition) {
          throw new GraphQLError(`Cannot query field "${name}" on type "${String(parentType)}"`, [
            selectionNode
          ]);
        }

        const fieldType = fieldDefinition.type;
        const unmodifiedFieldType = getNamedType(fieldType);

        this.addTypeUsed(unmodifiedFieldType);

        const { description, isDeprecated, deprecationReason } = fieldDefinition;

        let field: Field = {
          kind: 'Field',
          name,
          alias,
          args,
          type: fieldType,
          description: !isMetaFieldName(name) ? description : undefined,
          isDeprecated,
          deprecationReason
        };

        if (isCompositeType(unmodifiedFieldType)) {
          const selectionSetNode = selectionNode.selectionSet;
          if (!selectionSetNode) {
            throw new GraphQLError(
              `Composite field "${name}" on type "${String(parentType)}" requires selection set`,
              [selectionNode]
            );
          }

          field.selectionSet = this.compileSelectionSet(
            selectionNode.selectionSet as SelectionSetNode,
            unmodifiedFieldType
          );
        }
        return field;
        break;
      }
      case Kind.INLINE_FRAGMENT: {
        const typeNode = selectionNode.typeCondition;
        const type = typeNode ? typeFromAST(this.schema, typeNode) as GraphQLCompositeType : parentType;
        const possibleTypesForTypeCondition = this.possibleTypesForType(type).filter(type =>
          possibleTypes.includes(type)
        );
        return {
          kind: 'TypeCondition',
          type,
          selectionSet: this.compileSelectionSet(
            selectionNode.selectionSet,
            type,
            possibleTypesForTypeCondition
          )
        };
        break;
      }
      case Kind.FRAGMENT_SPREAD: {
        const fragmentName = selectionNode.name.value;
        return {
          kind: 'FragmentSpread',
          fragmentName
        };
        break;
      }
    }
  }

  possibleTypesForType(type: GraphQLCompositeType): GraphQLObjectType[] {
    if (isAbstractType(type)) {
      return this.schema.getPossibleTypes(type) || [];
    } else {
      return [type];
    }
  }
}
