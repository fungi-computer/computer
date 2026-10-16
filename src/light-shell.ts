import * as z from "zod";
import { Bash, getCommandNames } from "just-bash/browser";
import type { CommandNode, StatementNode, WordNode } from "just-bash";

export type ShellRoute =
  | Readonly<{ where: "light" }>
  | Readonly<{ where: "full"; reason: string }>
  | Readonly<{ where: "invalid"; message: string }>;

// These optional groups are intentionally absent from the Worker shell.
const deferredGroups = new Set(["sqlite3", "html-to-markdown"]);
export const lightShellCommands: readonly string[] = [
  ...getCommandNames().filter((name) => !deferredGroups.has(name)),
  "cd",
  "export",
];
const lightCommands = new Set(lightShellCommands);
// Constructed lazily: a module that only needs the command set or types
// (for example, a mounting React tree before any command is typed) should
// never pay for a real just-bash parser instance.
let parser: Bash | undefined;
function shellParser(): Bash {
  parser ??= new Bash({ commands: [] });
  return parser;
}

function literalWord(parts: WordNode["parts"]): string | null {
  let value = "";
  for (const part of parts) {
    if (part.type === "DoubleQuoted") {
      const quoted = literalWord(part.parts);
      if (quoted === null) return null;
      value += quoted;
    } else if (
      part.type === "Literal" ||
      part.type === "SingleQuoted" ||
      part.type === "Escaped"
    ) {
      value += part.value;
    } else return null;
  }
  return value;
}

function routeStatements(statements: readonly StatementNode[]): ShellRoute {
  for (const statement of statements) {
    if (statement.background)
      return { where: "full", reason: "background job" };
    if (statement.deferredError)
      return { where: "invalid", message: statement.deferredError.message };
    for (const pipeline of statement.pipelines) {
      for (const command of pipeline.commands) {
        const route = routeCommand(command);
        if (route.where !== "light") return route;
      }
    }
  }
  return { where: "light" };
}

function routeCommand(command: CommandNode): ShellRoute {
  for (const redirection of command.redirections) {
    if (redirection.target.type === "HereDoc" && redirection.target.quoted)
      continue;
    const word =
      redirection.target.type === "HereDoc"
        ? redirection.target.content
        : redirection.target;
    const route = routeWord(word.parts);
    if (route.where !== "light") return route;
  }
  if (command.type === "SimpleCommand") {
    const name = command.name === null ? null : literalWord(command.name.parts);
    if (name !== null && !lightCommands.has(name))
      return { where: "full", reason: name };
    const words = [
      ...(command.name === null ? [] : [command.name]),
      ...command.args,
      ...command.assignments.flatMap((assignment) => [
        ...(assignment.value === null ? [] : [assignment.value]),
        ...(assignment.array ?? []),
      ]),
    ];
    for (const word of words) {
      const route = routeWord(word.parts);
      if (route.where !== "light") return route;
    }
    return { where: "light" };
  }
  if (command.type === "If") {
    for (const clause of command.clauses) {
      const route = routeStatements([...clause.condition, ...clause.body]);
      if (route.where !== "light") return route;
    }
    return routeStatements(command.elseBody ?? []);
  }
  if (command.type === "While" || command.type === "Until")
    return routeStatements([...command.condition, ...command.body]);
  if (command.type === "Subshell" || command.type === "Group")
    return routeStatements(command.body);
  if (command.type === "FunctionDef") return routeCommand(command.body);
  if (command.type === "For") {
    for (const word of command.words ?? []) {
      const route = routeWord(word.parts);
      if (route.where !== "light") return route;
    }
    return routeStatements(command.body);
  }
  if (command.type === "Case") {
    const route = routeWord(command.word.parts);
    if (route.where !== "light") return route;
    for (const item of command.items) {
      for (const pattern of item.patterns) {
        const route = routeWord(pattern.parts);
        if (route.where !== "light") return route;
      }
      const route = routeStatements(item.body);
      if (route.where !== "light") return route;
    }
    return { where: "light" };
  }
  return { where: "full", reason: "shell expression" };
}

function routeWord(parts: WordNode["parts"]): ShellRoute {
  for (const part of parts) {
    if (
      part.type === "CommandSubstitution" ||
      part.type === "ProcessSubstitution"
    ) {
      const nested = routeStatements(part.body.statements);
      if (nested.where !== "light") return nested;
    } else if (part.type === "DoubleQuoted") {
      const nested = routeWord(part.parts);
      if (nested.where !== "light") return nested;
    } else if (part.type === "ArithmeticExpansion") {
      const nested = routeArithmetic(part.expression.expression);
      if (nested.where !== "light") return nested;
    } else if (part.type === "ParameterExpansion") {
      const nested = routeParameter(part.operation);
      if (nested.where !== "light") return nested;
    }
  }
  return { where: "light" };
}

type ArithmeticExpression = Extract<
  WordNode["parts"][number],
  { type: "ArithmeticExpansion" }
>["expression"]["expression"];

function routeArithmetic(expression: ArithmeticExpression): ShellRoute {
  if (expression.type === "ArithCommandSubst")
    return routeShellCommand(expression.command);
  // These forms expand and reparse text at execution time. Never replay them.
  if (
    expression.type === "ArithBracedExpansion" ||
    expression.type === "ArithDynamicBase" ||
    expression.type === "ArithDynamicNumber"
  )
    return { where: "full", reason: "dynamic arithmetic" };
  const children: ArithmeticExpression[] = [
    ...("left" in expression ? [expression.left] : []),
    ...("right" in expression ? [expression.right] : []),
    ...("operand" in expression ? [expression.operand] : []),
    ...("condition" in expression ? [expression.condition] : []),
    ...("consequent" in expression ? [expression.consequent] : []),
    ...("alternate" in expression ? [expression.alternate] : []),
    ...(expression.type === "ArithAssignment" ||
    expression.type === "ArithDynamicAssignment"
      ? [expression.value]
      : []),
    ...("subscript" in expression ? [expression.subscript] : []),
    ...("target" in expression ? [expression.target] : []),
    ...("nameExpr" in expression ? [expression.nameExpr] : []),
    ...("index" in expression ? [expression.index] : []),
    ...("expression" in expression ? [expression.expression] : []),
    ...("parts" in expression ? expression.parts : []),
  ];
  for (const child of children) {
    const route = routeArithmetic(child);
    if (route.where !== "light") return route;
  }
  return { where: "light" };
}

type ParameterOperation = Extract<
  WordNode["parts"][number],
  { type: "ParameterExpansion" }
>["operation"];

function routeParameter(operation: ParameterOperation | undefined): ShellRoute {
  if (!operation) return { where: "light" };
  const words = [
    ...("word" in operation && operation.word ? [operation.word] : []),
    ...("pattern" in operation && operation.pattern ? [operation.pattern] : []),
    ...("replacement" in operation && operation.replacement
      ? [operation.replacement]
      : []),
  ];
  for (const word of words) {
    const route = routeWord(word.parts);
    if (route.where !== "light") return route;
  }
  return "innerOp" in operation
    ? routeParameter(operation.innerOp)
    : { where: "light" };
}

type ParsedShell =
  | Readonly<{ kind: "parsed"; ast: ReturnType<Bash["transform"]>["ast"] }>
  | Readonly<{ kind: "invalid"; message: string }>;
function parseShell(source: string): ParsedShell {
  try {
    return { kind: "parsed", ast: shellParser().transform(source).ast };
  } catch (cause) {
    return {
      kind: "invalid",
      message: cause instanceof Error ? cause.message : "Invalid shell syntax",
    };
  }
}

/** Route the maintained parser's AST before either backend executes anything. */
export function routeShellCommand(source: string): ShellRoute {
  const parsed = parseShell(source);
  return parsed.kind === "invalid"
    ? { where: "invalid", message: parsed.message }
    : routeStatements(parsed.ast.statements);
}

export type CommandCompletion = Readonly<{
  name: string;
  where: "light" | "full";
}>;
const fullCompletionCommands = [
  "bun",
  "cargo",
  "curl",
  "docker",
  "git",
  "go",
  "make",
  "nano",
  "node",
  "npm",
  "npx",
  "pnpm",
  "python3",
  "ssh",
  "vim",
  "wget",
];
const completionCommands = [
  ...new Set([...lightShellCommands, ...fullCompletionCommands]),
].sort();

/** First-word completion reads the maintained AST; quoted/path completion is deferred. */
export function completeShellCommand(
  source: string,
):
  | readonly CommandCompletion[]
  | null
  | Readonly<{ kind: "invalid"; message: string }> {
  const parsed = parseShell(source);
  if (parsed.kind === "invalid") return parsed;
  const statement = parsed.ast.statements[0];
  if (
    statement === undefined ||
    parsed.ast.statements.length !== 1 ||
    statement.background ||
    statement.deferredError ||
    statement.pipelines.length !== 1
  )
    return null;
  const pipeline = statement.pipelines[0];
  if (pipeline === undefined) return null;
  const command = pipeline.commands[0];
  if (
    command === undefined ||
    pipeline.commands.length !== 1 ||
    pipeline.negated ||
    pipeline.timed ||
    command.type !== "SimpleCommand" ||
    command.assignments.length !== 0 ||
    command.redirections.length !== 0 ||
    command.args.length !== 0 ||
    command.name === null
  )
    return null;
  const parts = command.name.parts;
  const part = parts[0];
  if (parts.length !== 1 || part?.type !== "Literal" || part.value !== source)
    return null;
  return completionCommands
    .filter((name) => name.startsWith(source))
    .map((name) => ({
      name,
      where: lightCommands.has(name) ? "light" : "full",
    }));
}

/**
 * `cd`/`export` route light (they need no external program), but the exec
 * primitive behind a light command has no state event yet: each run is its
 * own process, so a bare `cd`/`export` would report success and change
 * nothing the next command sees. True only for a line that is exactly one
 * such invocation, so the caller can refuse it honestly instead of faking a
 * result; a `cd`/`export` combined with other work is not detected here and
 * still runs, silently without the navigation/export effect, as today.
 */
export function bareNavigationCommand(
  source: string,
): Readonly<{ name: "cd" | "export" }> | null {
  const parsed = parseShell(source);
  if (parsed.kind === "invalid") return null;
  const statement = parsed.ast.statements[0];
  if (
    statement === undefined ||
    parsed.ast.statements.length !== 1 ||
    statement.background ||
    statement.deferredError ||
    statement.pipelines.length !== 1
  )
    return null;
  const pipeline = statement.pipelines[0];
  if (pipeline === undefined) return null;
  const command = pipeline.commands[0];
  if (
    command === undefined ||
    pipeline.commands.length !== 1 ||
    pipeline.negated ||
    pipeline.timed ||
    command.type !== "SimpleCommand" ||
    command.redirections.length !== 0
  )
    return null;
  const name = command.name === null ? null : literalWord(command.name.parts);
  return name === "cd" || name === "export" ? { name } : null;
}

const promptControlSchema = z.enum(["ordinary", "full", "light", "exit"]);
let promptParser: Bash | undefined;
function shellPromptParser(): Bash {
  if (promptParser !== undefined) return promptParser;
  const configured = new Bash({ commands: [] });
  configured.registerTransformPlugin({
    name: "fungi-shell-prompt",
    transform: ({ ast }) => {
      const statement = ast.statements[0];
      const pipeline = statement?.pipelines[0];
      const command = pipeline?.commands[0];
      if (command?.type !== "SimpleCommand" || command.assignments.length !== 0)
        return { ast, metadata: { control: "ordinary" } };
      const name =
        command.name === null ? null : literalWord(command.name.parts);
      const standalone =
        ast.statements.length === 1 &&
        statement?.pipelines.length === 1 &&
        pipeline?.commands.length === 1 &&
        !statement.background &&
        command.redirections.length === 0;
      if (
        (name === "light" || name === "exit") &&
        standalone &&
        command.args.length === 0
      )
        return { ast, metadata: { control: name } };
      if (name !== "full") return { ast, metadata: { control: "ordinary" } };
      const next = command.args.shift();
      if (next !== undefined) {
        command.name = next;
        return { ast, metadata: { control: "full" } };
      }
      return standalone
        ? { ast: { ...ast, statements: [] }, metadata: { control: "full" } }
        : { ast, metadata: { control: "ordinary" } };
    },
  });
  promptParser = configured;
  return configured;
}

/** Prompt controls never become a backend command or change model shell grammar. */
export function prepareShellPrompt(
  source: string,
):
  | Readonly<{ kind: "command"; command: string; route: ShellRoute }>
  | Readonly<{ kind: "light" | "exit" }>
  | Readonly<{ kind: "invalid"; message: string }> {
  try {
    const transformed = shellPromptParser().transform(source);
    const control = promptControlSchema.parse(transformed.metadata.control);
    if (control === "light" || control === "exit") return { kind: control };
    const command = control === "full" ? transformed.script : source;
    const route = routeStatements(transformed.ast.statements);
    return {
      kind: "command",
      command,
      route:
        route.where === "invalid"
          ? route
          : control === "full"
            ? { where: "full", reason: "explicit full" }
            : route,
    };
  } catch (cause) {
    return {
      kind: "invalid",
      message: cause instanceof Error ? cause.message : "Invalid shell syntax",
    };
  }
}
