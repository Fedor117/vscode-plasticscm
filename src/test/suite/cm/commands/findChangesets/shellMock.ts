import { ICmParser, ICmResult, ICmShell } from "../../../../../cm/shell";
import { IMock, It, Mock, MockBehavior } from "typemoq";

export interface IExecCall {
  args: string[];
  command: string;
}

export interface IShellMock {
  /** Every `exec` call in order, so tests can assert the exact command line cm would receive. */
  calls: IExecCall[];
  mock: IMock<ICmShell>;
}

/** A strict shell whose `exec` records each call and answers with one fixed result. */
export function mockShell<T>(result: ICmResult<T>): IShellMock {
  const mock: IMock<ICmShell> = Mock.ofType<ICmShell>(undefined, MockBehavior.Strict);
  const calls: IExecCall[] = [];

  mock
    .setup(shell => shell.exec(It.isAnyString(), It.is(() => true), It.is<ICmParser<T>>(() => true)))
    .callback((command: string, args: string[]) => {
      calls.push({ args, command });
    })
    .returns(() => Promise.resolve(result));

  return { calls, mock };
}
