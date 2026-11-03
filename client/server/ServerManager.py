import requests
from benchmark.HardwareProfile import HardwareProfile
from job.Archive import result_archive

_SERVER_URL = "https://localhost:5173"

class DeliveryError(requests.RequestException):
    """A result upload the server refused. `reason` is the server's own error text (no credentials)."""
    def __init__(self, status: int | None, reason: str):
        super().__init__(f"HTTP {status}: {reason}" if status else reason)
        self.status = status
        self.reason = reason

    @property
    def retryable(self) -> bool:
        # 409: the server hasn't seen DELIVERY_PHASE_START yet (or a concurrent write); 5xx/None: transient
        return self.status is None or self.status in (409, 429) or self.status >= 500

class ServerManager():
    # identity (who am i to the server?)
    def __init__(self, base_url: str, access_token: str | None = None):
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers.update({
            "Accept": "application/json"
        })
        # The availability worker must not share a Requests session with job calls.
        self._heartbeat_session = requests.Session()
        self._heartbeat_session.headers.update({"Accept": "application/json"})

        if access_token is not None:
            self.set_access_token(access_token)

    # sets auth for server to know who its talking to    
    def set_access_token(self, token: str) -> None:
        self.session.headers['Authorization'] = f"Bearer {token}"    
        self._heartbeat_session.headers['Authorization'] = f"Bearer {token}"

    # request helper - generic
    def request(self, method: str, path: str, **kwargs) -> requests.Response:
        response = self.session.request(method, f"{self.base_url}/{path.lstrip('/')}", timeout=15, **kwargs)
        response.raise_for_status()
        return response

    # throws if post failed
    def post_benchmark(self, profile: HardwareProfile) -> None:
        try:
            self.request("POST", "/scores", json=profile.to_json())
        except requests.HTTPError as e:
            detail = e.response.text[:500] if e.response is not None else ""
            raise requests.HTTPError(f"Failed to post benchmark: {e} {detail}".strip(), response=e.response)

    # cleanup :D
    def close(self) -> None:
        self.session.close()
        self._heartbeat_session.close()

    def heartbeat(self) -> None:
        self._heartbeat_session.verify = self.session.verify
        response = self._heartbeat_session.post(f"{self.base_url}/provider/heartbeat", timeout=15)
        response.raise_for_status()

    # the wallet this API key was issued to, as recorded with the benchmark; None if the server
    # doesn't expose it (e.g. the dev mock)
    def get_hardware_address(self) -> str | None:
        try:
            res = self.request("GET", "/provider/hardware")
        except requests.HTTPError as e:
            if e.response is not None and e.response.status_code == 404:
                return None
            raise
        hardware = res.json().get('hardware') or {}
        return hardware.get('address')

    def getDockerManifest(self, jobId):
        res = self.request("GET", f"/jobManifest/{jobId}")
        
        print("manifest obtained: ", res.json()['manifest'])
        return res.json()['manifest']

    def report_error(self, jobId, message: str) -> None:
        # Job workers do not share the polling/heartbeat Requests sessions.
        with requests.Session() as session:
            session.headers.update(self.session.headers)
            session.verify = self.session.verify
            response = session.post(
                f"{self.base_url}/provider/jobs/{jobId}/error",
                json={"message": message[:4096]}, timeout=15,
            )
            response.raise_for_status()

    def deliver_result(self, job_id, output_dir, result_hash, stop_event=None):
        # Workers have their own session; account credentials stay on the API origin.
        with result_archive(output_dir, result_hash, stop_event) as (archive, size), requests.Session() as session:
            session.headers.update(self.session.headers)
            session.verify = self.session.verify
            try:
                response = session.post(
                    f'{self.base_url}/provider/results/{int(job_id)}',
                    data=archive, headers={'Content-Type': 'application/x-tar',
                                          'Content-Length': str(size), 'X-Result-Hash': result_hash.hex()},
                    timeout=(10, 60), allow_redirects=False,
                )
                if not 200 <= response.status_code < 300:
                    try:
                        reason = str(response.json().get('error') or 'upload was not accepted')
                    except Exception:  # non-JSON body
                        reason = 'upload was not accepted'
                    raise DeliveryError(response.status_code, reason[:300])
                result = response.json()
                if not isinstance(result, dict) or not isinstance(result.get('results'), list) or not any(
                    isinstance(item, dict) and item.get('contentVerified') is True and (
                        item.get('receiptVerified') is True or
                        (item.get('receiptMode') or result.get('receiptMode')) in ('offchain', 'local')
                    )
                    for item in result.get('results', [])
                ):
                    raise DeliveryError(response.status_code, 'result delivery is not confirmed')
                return result
            except DeliveryError:
                raise
            except (requests.RequestException, ValueError):
                # Exception text from an HTTP library can include URL credentials or headers.
                raise DeliveryError(None, 'result upload failed (network or bad response)') from None
