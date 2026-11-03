We need the following system:

docker compose up should spin up the system (server, frontend, db, and blockchain), and expose the following services to be hosted on hardcoded ports, available externally from the network.

(when I say public, I mean I should be able to access it from another machine)
The server should run on a public port, the database should run internally on the machine that spins up the server, frontend should be ran locally on each machine, and point to the single spun up server. Blockchain should likewise be exposed, and other machines should be able to connect to it.

All of these things should be hardcoded so that I can spin up the server on a hosting machine, and then run the same (or similar command) on another machine that would point to the hosting machine and communicate with it.

Essentially, milestone3 branch has code that works on a localhost, single machine setting. Now, we want to run a docker container such that we can test the interoperability between machines (ie different machine provider)

I want to be able to have an argument in my docker compose so that i can run it in different modes: host mode and client mode.

Host mode should host hte services described above, client mode should connect to them and spin up the client.
