import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { OrderSummaryComponent } from '../../shared/components/order-summary/order-summary.component';
import { MatStepper, MatStepperModule } from '@angular/material/stepper';
import { Router, RouterLink } from '@angular/router';
import { MatButton } from '@angular/material/button';
import {
  MatCheckboxChange,
  MatCheckboxModule,
} from '@angular/material/checkbox';
import { StripeService } from '../../core/services/stripe.service';
import {
  ConfirmationToken,
  StripeAddressElement,
  StripeAddressElementChangeEvent,
  StripePaymentElement,
  StripePaymentElementChangeEvent,
} from '@stripe/stripe-js';
import { SnackbarService } from '../../core/services/snackbar.service';
import { StepperSelectionEvent } from '@angular/cdk/stepper';
import { Address } from '../../shared/models/user';
import { firstValueFrom } from 'rxjs';
import { AccountService } from '../../core/services/account.service';
import { CheckoutDeliveryComponent } from './checkout-delivery/checkout-delivery.component';
import { CheckoutReviewComponent } from './checkout-review/checkout-review.component';
import { CartService } from '../../core/services/cart.service';
import { AsyncPipe, CurrencyPipe } from '@angular/common';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { OrderToCreate, ShippingAddress } from '../../shared/models/order';
import { OrderService } from '../../core/services/order.service';
import { BreakpointObserver, Breakpoints } from '@angular/cdk/layout';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { finalize } from 'rxjs/operators';

@Component({
  selector: 'app-checkout',
  imports: [
    OrderSummaryComponent,
    MatStepperModule,
    RouterLink,
    MatButton,
    MatCheckboxModule,
    CheckoutDeliveryComponent,
    CheckoutReviewComponent,
    CurrencyPipe,
    MatProgressSpinnerModule,
    AsyncPipe
  ],
  templateUrl: './checkout.component.html',
  styleUrl: './checkout.component.scss',
})
export class CheckoutComponent implements OnInit, OnDestroy {
  private stripeService = inject(StripeService);
  private accountService = inject(AccountService);
  private router = inject(Router);
  private orderService = inject(OrderService);
  private snackbar = inject(SnackbarService);
  cartService = inject(CartService);
  addressElement?: StripeAddressElement;
  paymentElement?: StripePaymentElement;
  saveAddress = false;
  completionStatus = signal<{
    address: boolean;
    card: boolean;
    delivery: boolean;
  }>({ address: false, card: false, delivery: false });
  confirmationToken?: ConfirmationToken;
  loading = false;
  isSmallScreen$: Observable<boolean>;
  private paymentAttemptCount = 0;
  private maxPaymentAttempts = 2; // Maximum number of payment attempts before showing an error

  constructor(private breakpointObserver: BreakpointObserver) {
    this.isSmallScreen$ = this.breakpointObserver
      .observe([Breakpoints.XSmall, Breakpoints.Small])
      .pipe(map(result => result.matches));
  }

  async ngOnInit() {
    try {
      // First ensure we have an updated payment intent for the cart
      await firstValueFrom(this.stripeService.createOrUpdatePaymentIntent());
      
      this.addressElement = await this.stripeService.createAddressElement();
      this.addressElement.mount('#address-element');
      this.addressElement.on('change', this.handleAddressChange);

      this.paymentElement = await this.stripeService.createPaymentElement();
      this.paymentElement.mount('#payment-element');
      this.paymentElement.on('change', this.handlePaymentChange);
    } catch (error: any) {
      this.snackbar.error(error.message);
    }
  }

  handleAddressChange = (event: StripeAddressElementChangeEvent) => {
    this.completionStatus.update((state) => {
      state.address = event.complete;
      return state;
    });
  };

  handlePaymentChange = (event: StripePaymentElementChangeEvent) => {
    this.completionStatus.update((state) => {
      state.card = event.complete;
      return state;
    });
  };

  handleDeliveryChange(event: boolean) {
    this.completionStatus.update((state) => {
      state.delivery = event;
      return state;
    });
  }

  async getConfirmationToken() {
    try {
      // Ensure all steps are completed
      if (Object.values(this.completionStatus()).every(status => status === true)) {
        // Ensure payment intent is up to date before creating confirmation token
        await firstValueFrom(this.stripeService.createOrUpdatePaymentIntent());
        
        const result = await this.stripeService.createConfirmationToken();
        if (result.error) throw new Error(result.error.message);
        this.confirmationToken = result.confirmationToken;
      }
    } catch (error: any) {
      this.snackbar.error(error.message);
    }
  }

  async onStepChange(event: StepperSelectionEvent) {
    if (event.selectedIndex === 1) {
      if (this.saveAddress) {
        const address = (await this.getAddressFromStripeAddress()) as Address;
        address && await firstValueFrom(this.accountService.updateAddress(address));
      }
    }
    if (event.selectedIndex == 2) {
      await firstValueFrom(this.stripeService.createOrUpdatePaymentIntent());
    }
    if (event.selectedIndex === 3) {
      await this.getConfirmationToken();
    }
  }

  async confirmPayment(stepper: MatStepper) {
    if (this.loading) return; // Prevent multiple concurrent clicks
    
    this.loading = true;
    this.paymentAttemptCount++;
    
    try {
      if (!this.confirmationToken) {
        // Attempt to recreate the confirmation token if it's missing
        await this.getConfirmationToken();
        if (!this.confirmationToken) {
          throw new Error('Could not create payment confirmation token');
        }
      }

      const result = await this.stripeService.confirmPayment(this.confirmationToken);

      if (result.paymentIntent?.status === 'succeeded') {
        const order = await this.createOrderModel();
        const orderResult = await firstValueFrom(
          this.orderService.createOrder(order)
        );
        if (orderResult) {
          this.orderService.orderComplete = true;
          this.cartService.deleteCart();
          this.cartService.selectedDelivery.set(null);
          this.router.navigateByUrl('/checkout/success');
        } else {
          throw new Error('Order creation failed');
        }
      } else if (result.error) {
        throw new Error(result.error.message);
      } else {
        throw new Error('Something went wrong with the payment process');
      }
    } catch (error: any) {
      const errorMessage = error.message || 'Something went wrong';
      
      // If we've already tried the maximum number of times, show error
      if (this.paymentAttemptCount >= this.maxPaymentAttempts) {
        this.snackbar.error(`${errorMessage} - Please refresh the page and try again.`);
        stepper.previous();
      } else {
        // Otherwise, try to regenerate elements and retry
        this.snackbar.error(`${errorMessage} - Retrying...`);
        
        // Reset and regenerate elements
        this.stripeService.disposeElements();
        this.confirmationToken = undefined;
        
        // Go back to payment step to recreate elements
        stepper.previous();
        
        // Try to reinitialize stripe elements
        try {
          await firstValueFrom(this.stripeService.createOrUpdatePaymentIntent());
          this.paymentElement = await this.stripeService.createPaymentElement();
          this.paymentElement.mount('#payment-element');
          this.paymentElement.on('change', this.handlePaymentChange);
        } catch (initError: any) {
          this.snackbar.error(`Failed to reinitialize payment: ${initError.message}`);
        }
      }
    } finally {
      this.loading = false;
    }
  }

  private async createOrderModel(): Promise<OrderToCreate> {
    const cart = this.cartService.cart();
    const shippingAddres =
      (await this.getAddressFromStripeAddress()) as ShippingAddress;
    const card = this.confirmationToken?.payment_method_preview.card;

    if (!cart?.id || !cart.deliveryMethodId || !card || !shippingAddres) {
      throw new Error('Problem creating order');
    }

    return {
      cartId: cart.id,
      paymentSummary: {
        last4: +card.last4,
        brand: card.brand,
        expMonth: card.exp_month,
        expYear: card.exp_year,
      },
      deliveryMethodId: cart.deliveryMethodId,
      shippingAddress: shippingAddres,
      discount: this.cartService.totals()?.discount,
    };
  }

  private async getAddressFromStripeAddress(): Promise<
    Address | ShippingAddress | null
  > {
    const result = await this.addressElement?.getValue();
    const address = result?.value.address;

    if (address) {
      return {
        name: result.value.name,
        line1: address.line1,
        line2: address.line2 || undefined,
        city: address.city,
        country: address.country,
        state: address.state,
        postalCode: address.postal_code,
      };
    } else {
      return null;
    }
  }

  onSaveAddressCheckboxChange(event: MatCheckboxChange) {
    this.saveAddress = event.checked;
  }

  ngOnDestroy(): void {
    // Only dispose elements if we're navigating away from checkout (not during payment process)
    if (!this.loading) {
      this.stripeService.disposeElements();
    }
  }
}