import {
  daoExecutionDeployment,
  type DaoExecutionDeployment,
} from "./dao-published-execution";

/** Initial read availability reuses the existing wallet deployment contract.
 * Configuration syntax is not deployed-code, membership or action authority. */
export function renderedDaoDeployment(
  input: Parameters<typeof daoExecutionDeployment>[0],
): DaoExecutionDeployment | undefined {
  try {
    return daoExecutionDeployment(input);
  } catch {
    return undefined;
  }
}
