# OMO-AP-002: callable Autopilot specialist

This delivery implements the optional OpenCode assessment subagent described by [Issue #2](https://github.com/Artifaktory/oh-my-openagent/issues/2). It uses native named-task delegation, operator-controlled enrollment, native model configuration and a fresh policy snapshot per invocation. Public results report `effect: "not_attempted"`. Mandatory TaskUpdate effects remain assigned to [Issue #3](https://github.com/Artifaktory/oh-my-openagent/issues/3).

## Documentation

- [Operator configuration and rule edit/revert](../../reference/configuration.md#autopilot-opencode)
- [Implemented public protocol, internal producer and trust boundary](implementation.md)
- [AC01-AC11 verification surfaces, procedures and evidence limits](verification.md)

## Authority and acceptance

The technical authority is [OMO-AP-001 design 1.0](../omo-ap-001/design.md) at `e52f915831d238c42087a239e8bf3710b0d0d104`, SHA-256 `396b8adcd02a369a22553472a4d8a4733f0504cdf15432869c7ee7dfd6fa123e`. Its planning documents remain unchanged. Issue #2 implementation PLAN2 was accepted for bounded implementation; that decision is separate from runtime acceptance.

The [canonical Issue #2 record](https://github.com/Artifaktory/oh-my-openagent/issues/2) owns the candidate identity, execution evidence, review ledger and final acceptance/gate status. These documents describe the contract and how to verify it; they do not supply a final HEAD or replace that record. Earlier producer/checkpoint handoffs remain local historical evidence.

The [dated native qualification record and limits](verification.md#observed-qualification-on-2026-10-30) describe eleven completed driver groups on Windows OpenCode 1.19.4 / SDK 1.18.31. Ten used scripted transport decisions; only policy A/B/revert used actual model judgment through the recorded bridge. Required Quality completion, independent General/Security Full, triage and assembled acceptance remain pending at this documentation reconciliation. The record does not establish universal provider compatibility or a complete root-suite PASS.

Engineering Backbone procedures are supplied at `be9f1ad35c26030fad41a6af9c070c5c22326bac`. No optional quality/navigation profile activation or native role installation is claimed. Coordination owns Issue/Board reconciliation, the complete freeze and later publication. Number 5 is reserved for the qualified delivery and its [fragment](../../../changes/unreleased/5.md); reservation is not PR publication, merge or feature acceptance.
