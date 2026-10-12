import requests
from benchmark.Scores import Scores

_SERVER_URL = "https://localhost:5173"

class ServerManager():
    # identity (who am i to the server?)
    def __init__(self, base_url: str, access_token: str | None = None):
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers.update({
            "Accept": "application/json"
        })

        if access_token is not None:
            self.set_access_token(access_token)

    # sets auth for server to know who its talking to    
    def set_access_token(self, token: str) -> None:
        self.session.headers['Authorization'] = f"Bearer {token}"    

    # request helper - generic
    def request(self, method: str, path: str, **kwargs) -> requests.Response:
        response = self.session.request(method, f"{self.base_url}/{path.lstrip('/')}", timeout=15, **kwargs)
        response.raise_for_status()
        return response

    # throws if post failed
    def post_benchmark(self, scores: Scores) -> None:
        # post scores

        data = {
            "cpu": scores.cpu,
            "gpu": scores.gpu,
            "mem": scores.memory
        }
        try:
            self.request("POST", "/scores", data=data)        
        except requests.HTTPError as e:
            raise requests.HTTPError(f"Failed to post benchmark: {e}")

    # cleanup :D
    def close(self) -> None:
        self.session.close()