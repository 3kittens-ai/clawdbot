import Foundation
import os

@MainActor
final class PeekabooBridgeHostCoordinator {
    static let shared = PeekabooBridgeHostCoordinator()

    private let logger = Logger(subsystem: "ai.openclaw", category: "PeekabooBridge")
    private var isEnabled = false

    func setEnabled(_ enabled: Bool) async {
        self.isEnabled = enabled
        if enabled {
            self.logger.info("PeekabooBridge is temporarily disabled in this build")
        } else {
            self.logger.info("PeekabooBridge disabled")
        }
    }

    func stop() async {
        self.isEnabled = false
        self.logger.info("PeekabooBridge stopped")
    }
}
