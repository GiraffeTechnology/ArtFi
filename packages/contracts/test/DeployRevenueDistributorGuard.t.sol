// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IHistoricalFractionToken} from "../src/RevenueDistributor.sol";
import {FractionalToken} from "../src/FractionalToken.sol";

/// @dev Mirrors `DeployRevenueDistributor._requireHistoricalFractionToken`. The script itself
///      reads its inputs from the environment, which a Foundry test cannot drive, so the probe
///      is exercised through an identical copy. Any change to one must change the other.
library FractionTokenProbe {
    error FractionTokenHasNoCode(address candidate);
    error FractionTokenInterfaceMissing(address candidate);

    function check(address candidate) internal view {
        if (candidate.code.length == 0) revert FractionTokenHasNoCode(candidate);
        try IHistoricalFractionToken(candidate).clock() returns (uint48 currentClock) {
            if (currentClock == 0) revert FractionTokenInterfaceMissing(candidate);
        } catch {
            revert FractionTokenInterfaceMissing(candidate);
        }
        try IHistoricalFractionToken(candidate).getPastTotalSupply(0) returns (uint256) {}
        catch {
            revert FractionTokenInterfaceMissing(candidate);
        }
    }
}

contract ProbeHarness {
    function check(address candidate) external view {
        FractionTokenProbe.check(candidate);
    }
}

/// @notice A deployed contract that is not a historical fraction token.
contract NotAFractionToken {
    function unrelated() external pure returns (uint256) {
        return 1;
    }
}

contract DeployRevenueDistributorGuardTest {
    ProbeHarness private harness;
    FractionalToken private token;
    NotAFractionToken private impostor;

    function setUp() public {
        harness = new ProbeHarness();
        token = new FractionalToken(
            "Fraction", "FRC", address(this), 1000, address(this), address(this)
        );
        impostor = new NotAFractionToken();
    }

    function _rejects(address candidate) private view returns (bool) {
        try harness.check(candidate) {
            return false;
        } catch {
            return true;
        }
    }

    /// An EOA has no code. Passing one today deploys a distributor whose immutable
    /// fractionToken can never answer, and the deployment reports success.
    function testRejectsAddressWithoutCode() public view {
        require(_rejects(address(0xBEEF)), "address without code accepted");
    }

    /// A deployed contract that does not implement the interface must be rejected too:
    /// having code is not the same as being the dependency.
    function testRejectsContractWithoutInterface() public view {
        require(_rejects(address(impostor)), "impostor contract accepted");
    }

    /// The real token must pass, otherwise the guard blocks legitimate deployments.
    function testAcceptsFractionalToken() public view {
        require(!_rejects(address(token)), "genuine fraction token rejected");
    }
}
