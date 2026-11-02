import requests
from benchmark.HardwareProfile import HardwareProfile

_SERVER_URL = "https://localhost:5173"

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
