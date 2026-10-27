package app.gendragoon.cloudssd.mobile;

/** Actual worker bodies remain active until native/Python returns, even after cancellation. */
final class TransferLease {
    private static int active;
    static synchronized boolean active(){return active>0;}
    static synchronized void enter(){active++;}
    static synchronized void leave(){if(active<1)throw new IllegalStateException("Transfer lease imbalance");active--;}
}
