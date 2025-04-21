namespace Core.Entities.OrderAggregate;

public enum OrderStatus
{
    Pending,
    PaymentRecieved,
    PaymentFailed,
    PaymentMismatch
}
