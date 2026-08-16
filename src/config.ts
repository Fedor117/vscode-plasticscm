export interface IConfig {
  autorefresh: boolean;
  consolidateUnrealOneFilePerActorChanges: boolean;
  cmConfiguration: IShellConfig;
  enabled: boolean;
  /** Top-level directory names whose churn must not trigger a status refresh. */
  ignoredDirectories: string[];
}

export interface IShellConfig {
  cmPath: string;
  millisToStop: number;
  millisToWaitUntilUp: number;
  millisCommandTimeout: number;
}
