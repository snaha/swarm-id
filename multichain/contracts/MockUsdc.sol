// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// LOCAL DEV ONLY — mock USD Coin for the fake-mainnet source chain.
/// Open mint: the dev faucet is the only user, and the chain is worthless.
///
/// The runtime bytecode vendored in `src/mock-usdc-bytecode.ts` is this
/// contract, compiled with optimizer on (200 runs):
///
///   docker run --rm -v "$PWD:/work" -w /work --entrypoint forge \
///     ghcr.io/foundry-rs/foundry:v1.8.1 build
///   … then `forge inspect contracts/MockUsdc.sol:MockUsdc deployedBytecode`.
contract MockUsdc {

    string public constant name = "USD Coin";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
        totalSupply += value;
        emit Transfer(address(0), to, value);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return _move(msg.sender, to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "allowance");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - value;
        }
        return _move(from, to, value);
    }

    function _move(address from, address to, uint256 value) internal returns (bool) {
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }
}
