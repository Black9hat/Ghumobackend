import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
    vus: 10,
    duration: "30s",
};

const URL = "https://chauncey-unpercolated-roastingly.ngrok-free.dev/api/trip/short";

export default function () {

    const payload = JSON.stringify({
        type: "short",
        customerId: "68e24aea3b861586df2d728e",

        pickup: {
            coordinates: [78.4867, 17.3850],
            address: "Hyderabad"
        },

        drop: {
            coordinates: [78.4123, 17.4500],
            address: "Kukatpally"
        },

        fare: 50,  // required
        vehicleType: "bike"   // ✅ NEW required field
    });

    const params = {
        headers: { "Content-Type": "application/json" }
    };

    const res = http.post(URL, payload, params);

    console.log("STATUS:", res.status);
    console.log("BODY:", res.body);

    check(res, {
        "status is 200": (r) => r.status === 200,
    });

    sleep(1);
}
