import { ICmExecOptions, ICmParser, ICmResult, ICmShell } from "../../../../../cm/shell";
import { IMock, It, Mock, MockBehavior } from "typemoq";

export interface IExecCall {
  args: string[];
  command: string;
  /** Only present when the caller passed options, so existing `eql` assertions stay exact. */
  options?: ICmExecOptions;
}

export interface IShellMock {
  /** Every `exec` call in order, so tests can assert the exact command line cm would receive. */
  calls: IExecCall[];
  mock: IMock<ICmShell>;
}

/** A strict shell whose `exec` records each call and answers with one fixed result. */
export function mockShell<T>(result: ICmResult<T>): IShellMock {
  return mockShellAnswering<T>(() => result);
}

/** Like {@link mockShell}, but the answer depends on the call (e.g. one result per query). */
export function mockShellAnswering<T>(answer: (call: IExecCall) => ICmResult<T>): IShellMock {
  const mock: IMock<ICmShell> = Mock.ofType<ICmShell>(undefined, MockBehavior.Strict);
  const calls: IExecCall[] = [];
  let last: IExecCall | undefined;

  const record = (command: string, args: string[], options?: ICmExecOptions) => {
    last = options === undefined ? { args, command } : { args, command, options };
    calls.push(last);
  };

  // typemoq matches on the argument count, so callers that pass options and
  // callers that don't each need their own setup.
  mock
    .setup(shell => shell.exec(It.isAnyString(), It.is(() => true), It.is<ICmParser<T>>(() => true)))
    .callback((command: string, args: string[]) => record(command, args))
    .returns(() => Promise.resolve(answer(last!)));
  mock
    .setup(shell => shell.exec(
      It.isAnyString(),
      It.is(() => true),
      It.is<ICmParser<T>>(() => true),
      It.is<ICmExecOptions | undefined>(() => true)))
    .callback((command: string, args: string[], _parser: ICmParser<T>, options?: ICmExecOptions) =>
      record(command, args, options))
    .returns(() => Promise.resolve(answer(last!)));

  return { calls, mock };
}
