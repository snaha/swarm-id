Identity Management PoC\#1 Requirements

# User Stories

The use case is “gateway usage with gated content”. As a basic setup we assume the following:

- There is a gateway running on a remote server.
- Gateway means a 3rd party Bee node with restricted endpoint availability (mostly GET and POST chunks, soc, feeds)
- The gateway isn’t trusted, but functionally implements what is expected.
- The user has a modern, up-to-date browser / JavaScript runtime.
- The user might have some off-the-shelf wallet manager, e.g. MetaMask plugin installed, but nothing custom-made for this project.
- The user interacts with the whole system using bee-js and other JavaScript libraries.

In the flows below we assume that the above conditions are met, and the gateway and the Javascript-based client are running.

The minimal user stories are:

1. As a **content creator**, I want to upload content from my desktop and my laptop using the same identity, so that all my content is verifiably owned by me and I can manage monetization from a single identity.
2. As a **content creator**, I want to share content with specific user identities (**user**s), so that the content is accessible only for those users.
3. As a **user**, I want to purchase access to a creator's content and access it, knowing that my access is tied to my personal identity, ensuring it's persistent and not dependent on any single intermediary node, gateway or user device.

# Generic Functional Requirements

- The solution has to be aligned with the long-term goal described in [Identity Management Research Canvas](https://docs.google.com/document/d/1ioF4lzbWHbOkRvZq4Snf1KO5GK46bvvptbqmSPlJ78w/edit?tab=t.0). It means that instead of SWIP the PoC and the ones after them will converge to a full implementation of the requirements as described in the canvas.
- The first PoC should be defined in a way that it is the first part of a series of PoCs that would lead to arriving at the long term goal.
- Separate the user identity (defined by a private and public key pair) from node identity.
- Separating the persona from user identity is not mandatory for this stage, but highly recommended, and also part of the long term goals.
- Creation of a specific Session key for a specific session, persona is nice-to-have.
- External stamp management is needed, including accounting for postage batch utilizations (where and how to store them? avoiding simultaneous writes; the problem of writing utilization data on Swarm changes the utilization; etc.)
- The solution must rely entirely on the JavaScript-based client application – i.e. no download/installation of other applications is needed (node, extension, etc).
- User metadata is stored in a way that might be stored locally in the PoC, but it’s easy to move it to Swarm in the future (e.g. by using a master stamp which is linked with the essential information about user state; serves as the entry point to look up other states)

# Non-functional Requirements

- Upload/download speeds: the solution has to provide upload/download speeds that opens the possibility of viewing 720p videos without significant lagging (assuming typical network conditions, and HLS videos).
- Should work for arbitrary large files, i.e. the available memory shouldn’t be a limit for file size, especially when introducing new primitives.
- Should be compatible with existing Swarm and BeeJS features.
- Future-proof interfaces, high quality code.
- Environment compatibility: support for mainstream JavaScript runtimes (e.g. browsers) where wallets are most frequently used.
- The node is not trusted, so the data going through or stored on it should be encrypted.

# Acceptable Limitations

- The solution can rely on the current implementation of ACT, so that if there are any bottlenecks on the Node side because of ACT, it can be accepted (it might affect e.g. the number of users).
- The client doesn't have to verify that the gateway has actually pushed the data and can serve it after receiving an HTTP 2xx response on uploads.
- The PoC doesn’t have to be prepared to avoid postage batch anonymity leaking.

# Deliverables

- Updated PoC proposal.
- Evaluation of architectural options to achieve the PoC goal (short summary).
- BeeJS PR or a separate library.
- Automatic tests with good coverage and covering edge cases.
- White label UI library (to be integrated into custom dApps).
- Demo application demonstrating the user flows. It should be branded for Swarm based on:
  - Logo and branding: [Swarm Logo 2022 (Original color)](https://drive.google.com/drive/folders/1y4O8-4jKBvT-kkJ2o7com0oCpfp-kuGL)
  - Color palette (please disregard 'about' and 'logo' sections): [Swarm Identity Guidelines v2.0.pdf](https://drive.google.com/file/d/1U4i_ciZ3YODyHRXxDevztDuVbviQdefx/view?usp=drive_link)
- List of limitations.

# Change Management

Every change to the specification has to be accepted by both parties and recorded in this document (and all relevant others) before the change itself is implemented. Changes requests are discussed on regular weekly meetings, i.e. not on other channels or more frequently. The change requests proposals have to be created in written form before the actual discussion.

# Communication

- Telegram group: mostly for blocker topics and sharing materials. Not for discussing or deciding specification changes.
- Weekly status meeting: reviewing the status, demonstration, clarifying smaller open questions.
- Irregular technical or scope discussion: organized when there are questions requiring longer time and perhaps specific audience.
