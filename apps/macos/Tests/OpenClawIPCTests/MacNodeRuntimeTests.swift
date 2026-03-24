import CoreLocation
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct MacNodeRuntimeTests {
    private struct FakeCalendarService: MacNodeCalendarServicing {
        var onEvents: (@Sendable (OpenClawCalendarEventsParams) async throws -> OpenClawCalendarEventsPayload)?
        var onAdd: (@Sendable (OpenClawCalendarAddParams) async throws -> OpenClawCalendarAddPayload)?

        func events(params: OpenClawCalendarEventsParams) async throws -> OpenClawCalendarEventsPayload {
            if let onEvents {
                return try await onEvents(params)
            }
            return OpenClawCalendarEventsPayload(events: [])
        }

        func add(params: OpenClawCalendarAddParams) async throws -> OpenClawCalendarAddPayload {
            if let onAdd {
                return try await onAdd(params)
            }
            return OpenClawCalendarAddPayload(event: OpenClawCalendarEventPayload(
                identifier: "test-event",
                title: params.title,
                startISO: params.startISO,
                endISO: params.endISO,
                isAllDay: params.isAllDay ?? false))
        }
    }

    @Test func `handle invoke rejects unknown command`() async {
        let runtime = MacNodeRuntime()
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-1", command: "unknown.command"))
        #expect(response.ok == false)
    }

    @Test func `handle invoke rejects empty system run`() async throws {
        let runtime = MacNodeRuntime()
        let params = OpenClawSystemRunParams(command: [])
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-2", command: OpenClawSystemCommand.run.rawValue, paramsJSON: json))
        #expect(response.ok == false)
    }

    @Test func `handle invoke rejects blocked system run env override before execution`() async throws {
        let runtime = MacNodeRuntime()
        let params = OpenClawSystemRunParams(
            command: ["/bin/sh", "-lc", "echo ok"],
            env: ["CLASSPATH": "/tmp/evil-classpath"])
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-2c", command: OpenClawSystemCommand.run.rawValue, paramsJSON: json))
        #expect(response.ok == false)
        #expect(response.error?.message.contains("SYSTEM_RUN_DENIED: environment override rejected") == true)
        #expect(response.error?.message.contains("CLASSPATH") == true)
    }

    @Test func `handle invoke rejects invalid system run env override key before execution`() async throws {
        let runtime = MacNodeRuntime()
        let params = OpenClawSystemRunParams(
            command: ["/bin/sh", "-lc", "echo ok"],
            env: ["BAD-KEY": "x"])
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-2d", command: OpenClawSystemCommand.run.rawValue, paramsJSON: json))
        #expect(response.ok == false)
        #expect(response.error?.message.contains("SYSTEM_RUN_DENIED: environment override rejected") == true)
        #expect(response.error?.message.contains("BAD-KEY") == true)
    }

    @Test func `handle invoke rejects empty system which`() async throws {
        let runtime = MacNodeRuntime()
        let params = OpenClawSystemWhichParams(bins: [])
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-2b", command: OpenClawSystemCommand.which.rawValue, paramsJSON: json))
        #expect(response.ok == false)
    }

    @Test func `handle invoke rejects empty notification`() async throws {
        let runtime = MacNodeRuntime()
        let params = OpenClawSystemNotifyParams(title: "", body: "")
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-3", command: OpenClawSystemCommand.notify.rawValue, paramsJSON: json))
        #expect(response.ok == false)
    }

    @Test func `handle invoke camera list requires enabled camera`() async {
        await TestIsolation.withUserDefaultsValues([cameraEnabledKey: false]) {
            let runtime = MacNodeRuntime()
            let response = await runtime.handleInvoke(
                BridgeInvokeRequest(id: "req-4", command: OpenClawCameraCommand.list.rawValue))
            #expect(response.ok == false)
            #expect(response.error?.message.contains("CAMERA_DISABLED") == true)
        }
    }

    @Test func `handle invoke screen record uses injected services`() async throws {
        @MainActor
        final class FakeMainActorServices: MacNodeRuntimeMainActorServices, @unchecked Sendable {
            func recordScreen(
                screenIndex: Int?,
                durationMs: Int?,
                fps: Double?,
                includeAudio: Bool?,
                outPath: String?) async throws -> (path: String, hasAudio: Bool)
            {
                let url = FileManager().temporaryDirectory
                    .appendingPathComponent("openclaw-test-screen-record-\(UUID().uuidString).mp4")
                try Data("ok".utf8).write(to: url)
                return (path: url.path, hasAudio: false)
            }

            func locationAuthorizationStatus() -> CLAuthorizationStatus {
                .authorizedAlways
            }

            func locationAccuracyAuthorization() -> CLAccuracyAuthorization {
                .fullAccuracy
            }

            func currentLocation(
                desiredAccuracy: OpenClawLocationAccuracy,
                maxAgeMs: Int?,
                timeoutMs: Int?) async throws -> CLLocation
            {
                CLLocation(latitude: 0, longitude: 0)
            }
        }

        let services = await MainActor.run { FakeMainActorServices() }
        let runtime = MacNodeRuntime(makeMainActorServices: { services })

        let params = MacNodeScreenRecordParams(durationMs: 250)
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-5", command: MacNodeScreenCommand.record.rawValue, paramsJSON: json))
        #expect(response.ok == true)
        let payloadJSON = try #require(response.payloadJSON)

        struct Payload: Decodable {
            var format: String
            var base64: String
        }
        let payload = try JSONDecoder().decode(Payload.self, from: Data(payloadJSON.utf8))
        #expect(payload.format == "mp4")
        #expect(!payload.base64.isEmpty)
    }

    @Test func `handle invoke browser proxy uses injected request`() async {
        let runtime = MacNodeRuntime(browserProxyRequest: { paramsJSON in
            #expect(paramsJSON?.contains("/tabs") == true)
            return #"{"result":{"ok":true,"tabs":[{"id":"tab-1"}]}}"#
        })
        let paramsJSON = #"{"method":"GET","path":"/tabs","timeoutMs":2500}"#
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-browser",
                command: OpenClawBrowserCommand.proxy.rawValue,
                paramsJSON: paramsJSON))

        #expect(response.ok == true)
        #expect(response.payloadJSON == #"{"result":{"ok":true,"tabs":[{"id":"tab-1"}]}}"#)
    }

    @Test func `handle invoke browser proxy rejects disabled browser control`() async throws {
        let override = TestIsolation.tempConfigPath()
        try await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            try JSONSerialization.data(withJSONObject: ["browser": ["enabled": false]])
                .write(to: URL(fileURLWithPath: override))

            let runtime = MacNodeRuntime(browserProxyRequest: { _ in
                Issue.record("browserProxyRequest should not run when browser control is disabled")
                return "{}"
            })
            let response = await runtime.handleInvoke(
                BridgeInvokeRequest(
                    id: "req-browser-disabled",
                    command: OpenClawBrowserCommand.proxy.rawValue,
                    paramsJSON: #"{"method":"GET","path":"/tabs"}"#))

            #expect(response.ok == false)
            #expect(response.error?.message.contains("BROWSER_DISABLED") == true)
        }
    }

    @Test func `handle invoke calendar add uses injected service`() async throws {
        let runtime = MacNodeRuntime(
            calendarService: FakeCalendarService(onAdd: { params in
                #expect(params.title == "Dentist")
                return OpenClawCalendarAddPayload(event: OpenClawCalendarEventPayload(
                    identifier: "evt-1",
                    title: params.title,
                    startISO: params.startISO,
                    endISO: params.endISO,
                    isAllDay: false,
                    location: params.location,
                    calendarTitle: "Calendar"))
            }))

        let params = OpenClawCalendarAddParams(
            title: "Dentist",
            startISO: "2026-03-24T14:00:00Z",
            endISO: "2026-03-24T15:00:00Z",
            location: "Clinic")
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-calendar-add",
                command: OpenClawCalendarCommand.add.rawValue,
                paramsJSON: json))

        #expect(response.ok == true)
        let payloadJSON = try #require(response.payloadJSON)
        let payload = try JSONDecoder().decode(OpenClawCalendarAddPayload.self, from: Data(payloadJSON.utf8))
        #expect(payload.event.identifier == "evt-1")
        #expect(payload.event.title == "Dentist")
        #expect(payload.event.location == "Clinic")
    }
}
